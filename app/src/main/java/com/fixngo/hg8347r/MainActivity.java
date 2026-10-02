package com.fixngo.hg8347r;

import android.app.Activity;
import android.content.Context;
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
            "https://raw.githubusercontent.com/fixngoltd-rgb/HG8347R/main/app/src/main/assets/www/";
    private static final String[] UI_FILES = {"index.html", "style.css", "app.js"};

    private WebView web;
    private SharedPreferences prefs;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, String> jar = new LinkedHashMap<>();
    private boolean triedAssetFallback = false;

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
        pool.execute(this::updateUiFromRemote);
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

    private void updateUiFromRemote() {
        try {
            String base = prefs.getString("uiBase", DEFAULT_UI_BASE);
            if (base == null || base.isEmpty()) return;
            File tmp = new File(getFilesDir(), "www_tmp");
            deleteRecursive(tmp);
            tmp.mkdirs();
            for (String name : UI_FILES) {
                HttpURLConnection c = (HttpURLConnection) new URL(base + name + "?t=" + System.currentTimeMillis()).openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(8000);
                if (c.getResponseCode() != 200) { deleteRecursive(tmp); return; }
                byte[] data = readAll(c.getInputStream());
                if (data.length == 0) { deleteRecursive(tmp); return; }
                try (OutputStream o = new FileOutputStream(new File(tmp, name))) { o.write(data); }
            }
            File dst = new File(getFilesDir(), "www");
            String oldHash = hashDir(dst), newHash = hashDir(tmp);
            if (newHash.equals(oldHash)) { deleteRecursive(tmp); return; }
            deleteRecursive(dst);
            tmp.renameTo(dst);
            runOnUiThread(() -> web.evaluateJavascript("window.onUiUpdated && window.onUiUpdated()", null));
        } catch (Exception ignored) {
            // No internet or repo not reachable: keep what we have.
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
            List<String> sc = hf == null ? null : hf.get("Set-Cookie");
            if (sc != null) {
                for (String line : sc) {
                    String first = line.split(";", 2)[0];
                    int eq = first.indexOf('=');
                    if (eq > 0) { synchronized (jar) { jar.put(first.substring(0, eq).trim(), first.substring(eq + 1)); } }
                }
            }
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
    }
}
