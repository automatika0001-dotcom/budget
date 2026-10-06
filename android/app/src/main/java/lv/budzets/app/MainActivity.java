package lv.budzets.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Native shell for the Budžets app. The screens and logic are loaded from GitHub Pages,
 * so pushing to GitHub updates the app without reinstalling. Data is kept on the phone.
 */
public class MainActivity extends Activity {

    private static final int FILE_REQUEST = 42;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(0xFF101312);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                // Keep all web pages (including the SEB login) inside the app so the bank
                // redirect comes back here. Hand other links (Smart-ID, mailto, intent://) to Android.
                if (scheme.equals("http") || scheme.equals("https")) return false;
                try {
                    Intent intent = scheme.equals("intent")
                            ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                            : new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(intent);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "No app to open this link", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOfflinePage();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BuildConfig.APP_URL);
    }

    private void showOfflinePage() {
        String html = "<html><body style=\"background:#101312;color:#eef2ef;font-family:sans-serif;"
                + "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px\">"
                + "<h2>No connection</h2><p style=\"color:#8f9a95\">Budžets needs internet the very first time it opens.<br>After that it works offline.</p>"
                + "<button onclick=\"location.href='" + BuildConfig.APP_URL + "'\" style=\"background:#c8f26a;border:0;"
                + "border-radius:14px;padding:14px 28px;font-size:16px;font-weight:bold\">Try again</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Let the app close an open panel or switch tab first.
        web.evaluateJavascript("(window.__onBack && window.__onBack()) ? 'yes' : 'no'", value -> {
            if (value != null && value.contains("yes")) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Called from the web app (window.AndroidBridge) for things a WebView cannot do by itself. */
    private class Bridge {
        @JavascriptInterface
        public boolean isNative() {
            return true;
        }

        /** Save a backup file into Downloads. */
        @JavascriptInterface
        public String saveFile(String name, String content) {
            try {
                byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
                String where;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver cr = getContentResolver();
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("Could not create file");
                    try (OutputStream os = cr.openOutputStream(uri)) {
                        if (os == null) throw new Exception("Could not open file");
                        os.write(bytes);
                    }
                    where = "Downloads/" + name;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    File f = new File(dir, name);
                    try (FileOutputStream os = new FileOutputStream(f)) {
                        os.write(bytes);
                    }
                    where = f.getAbsolutePath();
                }
                return where;
            } catch (Exception e) {
                return "ERROR: " + e.getMessage();
            }
        }
    }
}
