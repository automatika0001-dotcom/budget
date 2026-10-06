package lv.budzets.app;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * Captures payment notifications (Google Wallet by default) the moment they appear.
 *
 * Battery: Android calls this service only when a notification is posted. Nothing polls,
 * no timers, no wake locks. Notifications from apps not on the watch list are ignored
 * immediately without reading their contents.
 *
 * Parsing happens in the web app, so it can be improved with a normal update (no new APK).
 * This class only stores the raw title/text in a small queue that the app reads on open.
 */
public class PaymentListener extends NotificationListenerService {

    static final String PREFS = "live_payments";
    static final String KEY_QUEUE = "queue";
    static final String KEY_RECENT = "recent";
    static final String KEY_WATCH = "watch";
    static final String KEY_ENABLED = "enabled";
    static final String DEFAULT_WATCH = "com.google.android.apps.walletnfcrel";
    private static final long DEDUPE_MS = 15 * 60 * 1000L;
    private static final int MAX_QUEUE = 200;

    /** Set by MainActivity while it is on screen, so new payments show instantly. */
    static WeakReference<MainActivity> visible = new WeakReference<>(null);

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (!p.getBoolean(KEY_ENABLED, true)) return;
            String pkg = sbn.getPackageName();
            if (!isWatched(p.getString(KEY_WATCH, DEFAULT_WATCH), pkg)) return;

            Notification n = sbn.getNotification();
            if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
            Bundle x = n.extras;
            String title = str(x.getCharSequence(Notification.EXTRA_TITLE));
            String text = str(x.getCharSequence(Notification.EXTRA_TEXT));
            String big = str(x.getCharSequence(Notification.EXTRA_BIG_TEXT));
            if (big.length() > text.length()) text = big;
            if (title.isEmpty() && text.isEmpty()) return;

            long now = System.currentTimeMillis();
            String sig = pkg + "|" + title + "|" + text;
            if (seenRecently(p, sig, now)) return; // same notification re-posted or updated

            JSONObject ev = new JSONObject();
            ev.put("id", pkg + ":" + sbn.getPostTime() + ":" + Math.abs(sig.hashCode()));
            ev.put("pkg", pkg);
            ev.put("title", title);
            ev.put("text", text);
            ev.put("time", sbn.getPostTime() > 0 ? sbn.getPostTime() : now);

            JSONArray q = new JSONArray(p.getString(KEY_QUEUE, "[]"));
            q.put(ev);
            while (q.length() > MAX_QUEUE) q.remove(0);
            p.edit().putString(KEY_QUEUE, q.toString()).apply();

            MainActivity a = visible.get();
            if (a != null) a.onLivePayment();
        } catch (Exception ignored) {
            // never crash the listener because of one odd notification
        }
    }

    private static boolean isWatched(String watch, String pkg) {
        for (String w : watch.split(",")) {
            w = w.trim();
            if (!w.isEmpty() && w.equals(pkg)) return true;
        }
        return false;
    }

    private static boolean seenRecently(SharedPreferences p, String sig, long now) throws Exception {
        JSONObject recent = new JSONObject(p.getString(KEY_RECENT, "{}"));
        JSONObject keep = new JSONObject();
        boolean seen = false;
        JSONArray names = recent.names();
        if (names != null) {
            for (int i = 0; i < names.length(); i++) {
                String k = names.getString(i);
                long t = recent.getLong(k);
                if (now - t < DEDUPE_MS) {
                    keep.put(k, t);
                    if (k.equals(sig)) seen = true;
                }
            }
        }
        if (!seen) keep.put(sig, now);
        p.edit().putString(KEY_RECENT, keep.toString()).apply();
        return seen;
    }

    private static String str(CharSequence c) {
        return c == null ? "" : c.toString().trim();
    }
}
