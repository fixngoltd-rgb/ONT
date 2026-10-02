package com.fixngo.hg8347r;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Thin native shell. The screens are plain HTML/JS (assets/www) shown in a WebView.
 * The ONT is reached through the "ONT" bridge below, which is what lets the UI talk to
 * http://192.168.100.1 without the browser cross-origin limits.
 *
 * The UI files can also be refreshed from GitHub on launch, so most changes
 * need no reinstall (see updateUiFromRemote).
 */
public class MainActivity extends Activity {

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
    private static final String DEFAULT_UI_BASE =
            "https://raw.githubusercontent.com/fixngoltd-rgb/ont/main/app/src/main/assets/www/";
    private static final String[] UI_FILES = {"index.html", "style.css", "app.js"};

    private WebView web;
    private SharedPreferences prefs;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, String> jar = new LinkedHashMap<>();
    private boolean triedAssetFallback = false;
    private volatile long lastUiCheck = 0;
    private volatile boolean uiChecking = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("hg8347r", MODE_PRIVATE);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        web.addJavascriptInterface(new Bridge(), "ONT");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                // A broken downloaded UI must never lock the app: fall back to the built-in one.
                if (r.isForMainFrame() && !triedAssetFallback) {
                    triedAssetFallback = true;
                    deleteRecursive(new File(getFilesDir(), "www"));
                    v.loadUrl("file:///android_asset/www/index.html");
                }
            }
        });

        loadUi();
        checkUi(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        checkUi(false);
    }

    private void checkUi(boolean force) {
        if (uiChecking) return;
        if (!force && System.currentTimeMillis() - lastUiCheck < 15000) return;
        uiChecking = true;
        pool.execute(() -> {
            try { updateUiFromRemote(); } finally { lastUiCheck = System.currentTimeMillis(); uiChecking = false; }
            runOnUiThread(() -> web.evaluateJavascript("window.onUiStatus && window.onUiStatus()", null));
        });
    }

    @Override
    public void onBackPressed() {
        // Let the page handle "back" (closing sheets). It calls ONT.exit() when nothing is open.
        web.evaluateJavascript("window.onBack ? window.onBack() : ONT.exit()", null);
    }

    private void loadUi() {
        File f = new File(new File(getFilesDir(), "www"), "index.html");
        web.loadUrl(f.exists() ? "file://" + f.getAbsolutePath()
                               : "file:///android_asset/www/index.html");
    }

    // ---------------------------------------------------------------- remote UI refresh

    private void setUiStatus(String msg) {
        String t = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
        prefs.edit().putString("uiStatus", t + " " + msg).apply();
    }

    /** Prefer a network that really has internet, even when the default one is the router's Wi-Fi without internet. */
    private HttpURLConnection openInternet(URL url) throws Exception {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities c = cm.getNetworkCapabilities(n);
                if (c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    return (HttpURLConnection) n.openConnection(url);
                }
            }
        }
        return (HttpURLConnection) url.openConnection();
    }

    private void updateUiFromRemote() {
        try {
            String base = prefs.getString("uiBase", DEFAULT_UI_BASE);
            if (base == null || base.isEmpty()) { setUiStatus("off"); return; }
            File tmp = new File(getFilesDir(), "www_tmp");
            deleteRecursive(tmp);
            tmp.mkdirs();
            for (String name : UI_FILES) {
                HttpURLConnection c = openInternet(new URL(base + name + "?t=" + System.currentTimeMillis()));
                c.setConnectTimeout(6000);
                c.setReadTimeout(10000);
                c.setUseCaches(false);
                int code = c.getResponseCode();
                if (code != 200) { deleteRecursive(tmp); setUiStatus("failed: " + name + " HTTP " + code); return; }
                byte[] data = readAll(c.getInputStream());
                if (data.length == 0) { deleteRecursive(tmp); setUiStatus("failed: " + name + " empty"); return; }
                try (OutputStream o = new FileOutputStream(new File(tmp, name))) { o.write(data); }
            }
            File dst = new File(getFilesDir(), "www");
            String oldHash = hashDir(dst), newHash = hashDir(tmp);
            if (newHash.equals(oldHash)) { deleteRecursive(tmp); setUiStatus("up to date"); return; }
            deleteRecursive(dst);
            if (!tmp.renameTo(dst)) { setUiStatus("failed: could not save"); return; }
            prefs.edit().putString("uiPending", "1").apply();
            setUiStatus("new version downloaded");
        } catch (Exception e) {
            setUiStatus("failed: " + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    private static String hashDir(File d) {
        long h = 1125899906842597L;
        File[] fs = d.listFiles();
        if (fs == null) return "none";
        java.util.Arrays.sort(fs);
        for (File f : fs) {
            try (InputStream in = new java.io.FileInputStream(f)) {
                byte[] b = readAll(in);
                for (byte x : b) h = 31 * h + x;
            } catch (Exception ignored) { }
        }
        return Long.toString(h);
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        f.delete();
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    // ---------------------------------------------------------------- ONT networking

    /** Use the Wi-Fi network explicitly, so it still works when Wi-Fi has no internet. */
    private HttpURLConnection open(URL url) throws Exception {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    return (HttpURLConnection) n.openConnection(url);
                }
            }
        }
        return (HttpURLConnection) url.openConnection();
    }

    private String cookieHeader() {
        synchronized (jar) {
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, String> e : jar.entrySet()) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
            return sb.toString();
        }
    }

    private String doRequest(String method, String path, String headersJson, String body) {
        JSONObject out = new JSONObject();
        try {
            String host = prefs.getString("host", "192.168.100.1");
            URL url = new URL("http://" + host + path);
            HttpURLConnection c = open(url);
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(6000);
            c.setReadTimeout(15000);
            c.setRequestMethod(method);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Referer", "http://" + host + "/");
            c.setRequestProperty("Origin", "http://" + host);
            c.setRequestProperty("Cache-Control", "no-cache");
            String ck = cookieHeader();
            if (!ck.isEmpty()) c.setRequestProperty("Cookie", ck);
            JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
            Iterator<String> it = h.keys();
            while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, h.getString(k)); }
            if ("POST".equals(method)) {
                byte[] bytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream o = c.getOutputStream()) { o.write(bytes); }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
            Map<String, List<String>> hf = c.getHeaderFields();
            StringBuilder hs = new StringBuilder();
            if (hf != null) {
                for (Map.Entry<String, List<String>> he : hf.entrySet()) {
                    String hk = he.getKey();
                    if (hk == null) continue;
                    for (String line : he.getValue()) {
                        hs.append(hk).append(": ").append(line).append(" | ");
                        if (hk.equalsIgnoreCase("Set-Cookie")) {
                            String first = line.split(";", 2)[0];
                            int eq = first.indexOf('=');
                            if (eq > 0) { synchronized (jar) { jar.put(first.substring(0, eq).trim(), first.substring(eq + 1)); } }
                        }
                    }
                }
            }
            out.put("headers", hs.toString());
            out.put("status", code);
            out.put("body", text);
            out.put("location", c.getHeaderField("Location"));
            out.put("sid", cookieHeader().contains("sid="));
        } catch (Exception e) {
            try {
                out.put("status", 0);
                out.put("body", "");
                out.put("error", String.valueOf(e));
            } catch (Exception ignored) { }
        }
        return out.toString();
    }

    // ---------------------------------------------------------------- JS bridge

    private class Bridge {
        @JavascriptInterface
        public void request(final int id, final String method, final String path,
                            final String headersJson, final String body) {
            pool.execute(() -> {
                final String res = doRequest(method, path, headersJson, body);
                runOnUiThread(() -> web.evaluateJavascript(
                        "window.__cb(" + id + "," + JSONObject.quote(res) + ")", null));
            });
        }

        @JavascriptInterface
        public void clearSession() { synchronized (jar) { jar.clear(); } }

        @JavascriptInterface
        public String getPref(String key, String def) { return prefs.getString(key, def); }

        @JavascriptInterface
        public void setPref(String key, String value) { prefs.edit().putString(key, value).apply(); }

        @JavascriptInterface
        public void resetUi() {
            deleteRecursive(new File(getFilesDir(), "www"));
            runOnUiThread(() -> web.loadUrl("file:///android_asset/www/index.html"));
        }

        @JavascriptInterface
        public void exit() { runOnUiThread(() -> finish()); }

        @JavascriptInterface
        public void openCapture() {
            runOnUiThread(() -> startActivity(new Intent(MainActivity.this, CaptureActivity.class)));
        }

        @JavascriptInterface
        public void copy(final String text) {
            runOnUiThread(() -> {
                ClipboardManager cb = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cb.setPrimaryClip(ClipData.newPlainText("HG8347R", text));
            });
        }

        @JavascriptInterface
        public int nativeVersion() { return 7; }

        @JavascriptInterface
        public void checkUiNow() { checkUi(true); }

        @JavascriptInterface
        public void ackUi() { prefs.edit().putString("uiPending", "0").apply(); }
    }
}
