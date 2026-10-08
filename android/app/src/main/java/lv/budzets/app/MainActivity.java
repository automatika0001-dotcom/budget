package lv.budzets.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
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
import java.util.HashSet;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native shell for the CBudget app. The screens and logic are loaded from GitHub Pages,
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
                + "<h2>No connection</h2><p style=\"color:#8f9a95\">CBudget needs internet the very first time it opens.<br>After that it works offline.</p>"
                + "<button onclick=\"location.href='" + BuildConfig.APP_URL + "'\" style=\"background:#c8f26a;border:0;"
                + "border-radius:14px;padding:14px 28px;font-size:16px;font-weight:bold\">Try again</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    // ---- foreground / background ----
    // In the background all JavaScript timers are paused (no battery use). Coming back to the
    // app tells the web app, which then syncs the bank and picks up queued live payments.
    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
        PaymentListener.visible = new java.lang.ref.WeakReference<>(this);
        web.evaluateJavascript("window.__onResume && window.__onResume()", null);
    }

    @Override
    protected void onPause() {
        PaymentListener.visible = new java.lang.ref.WeakReference<>(null);
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    /** Called by PaymentListener when a payment notification arrives while the app is on screen. */
    void onLivePayment() {
        runOnUiThread(() -> web.evaluateJavascript("window.__onLivePayment && window.__onLivePayment()", null));
    }

    private SharedPreferences livePrefs() {
        return getSharedPreferences(PaymentListener.PREFS, Context.MODE_PRIVATE);
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

        @JavascriptInterface
        public int nativeVersion() {
            return 3;
        }

        /** Open a website (Plaid, Enable Banking) in the phone's browser, where sign-in and file downloads work. */
        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> {
                try {
                    Uri u = Uri.parse(url);
                    if (!"https".equals(u.getScheme())) return;
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "No browser to open this link", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** True when the user has granted Notification access to CBudget. */
        @JavascriptInterface
        public boolean hasNotificationAccess() {
            String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
            ComponentName me = new ComponentName(MainActivity.this, PaymentListener.class);
            return flat != null && flat.contains(me.flattenToString());
        }

        @JavascriptInterface
        public void openNotificationAccess() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_SETTINGS));
                }
            });
        }

        /** Opens this app's info page (needed on Android 13+ to "Allow restricted settings"). */
        @JavascriptInterface
        public void openAppInfo() {
            runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
                startActivity(i);
            });
        }

        @JavascriptInterface
        public void setLiveEnabled(boolean on) {
            livePrefs().edit().putBoolean(PaymentListener.KEY_ENABLED, on).apply();
        }

        @JavascriptInterface
        public void setWatchedPackages(String csv) {
            livePrefs().edit().putString(PaymentListener.KEY_WATCH, csv == null || csv.trim().isEmpty() ? PaymentListener.DEFAULT_WATCH : csv).apply();
        }

        @JavascriptInterface
        public String getWatchedPackages() {
            return livePrefs().getString(PaymentListener.KEY_WATCH, PaymentListener.DEFAULT_WATCH);
        }

        /** Returns queued payment notifications as JSON. They stay queued until ackPaymentEvents. */
        @JavascriptInterface
        public String peekPaymentEvents() {
            return livePrefs().getString(PaymentListener.KEY_QUEUE, "[]");
        }

        /** Removes the given event ids (comma separated) after the web app has saved them. */
        @JavascriptInterface
        public synchronized void ackPaymentEvents(String idsCsv) {
            try {
                Set<String> ids = new HashSet<>();
                for (String id : idsCsv.split(",")) if (!id.isEmpty()) ids.add(id);
                SharedPreferences p = livePrefs();
                JSONArray q = new JSONArray(p.getString(PaymentListener.KEY_QUEUE, "[]"));
                JSONArray keep = new JSONArray();
                for (int i = 0; i < q.length(); i++) {
                    JSONObject ev = q.getJSONObject(i);
                    if (!ids.contains(ev.optString("id"))) keep.put(ev);
                }
                p.edit().putString(PaymentListener.KEY_QUEUE, keep.toString()).apply();
            } catch (Exception ignored) {
            }
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
