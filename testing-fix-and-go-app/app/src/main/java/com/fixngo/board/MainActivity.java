package com.fixngo.board;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Thin native shell. The real app is plain HTML/JS (assets/www) shown in a WebView,
 * talking straight to Supabase over the internet (no local-network bridge needed here).
 *
 * The UI files are refreshed from GitHub on every launch, so most changes to the
 * board app need no reinstall - just push to the repo and relaunch the app.
 */
public class MainActivity extends Activity {

    private static final String DEFAULT_UI_BASE =
            "https://raw.githubusercontent.com/fixngoltd-rgb/ont/main/testing-fix-and-go-app/app/src/main/assets/www/";
    private static final String[] UI_FILES = {"index.html", "style.css", "app.js"};

    private WebView web;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private boolean triedAssetFallback = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebChromeClient(new WebChromeClient()); // lets <input type=file capture> open the camera
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame() && !triedAssetFallback) {
                    triedAssetFallback = true;
                    deleteRecursive(new File(getFilesDir(), "www"));
                    v.loadUrl("file:///android_asset/www/index.html");
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // tel: links should open the phone dialer, not fail inside the WebView.
                if (url.startsWith("tel:")) {
                    startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse(url)));
                    return true;
                }
                return false;
            }
        });

        loadUi();
        pool.execute(this::updateUiFromRemote);
    }

    @Override
    public void onBackPressed() {
        // Let the page handle "back" (closing a detail screen / sheet) before exiting.
        web.evaluateJavascript("window.onBack ? window.onBack() : true", (result) -> {
            if ("false".equals(result)) {
                return;
            }
            if ("true".equals(result)) {
                MainActivity.super.onBackPressed();
            }
        });
    }

    private void loadUi() {
        File f = new File(new File(getFilesDir(), "www"), "index.html");
        web.loadUrl(f.exists() ? "file://" + f.getAbsolutePath()
                               : "file:///android_asset/www/index.html");
    }

    private void updateUiFromRemote() {
        try {
            File tmp = new File(getFilesDir(), "www_tmp");
            deleteRecursive(tmp);
            tmp.mkdirs();
            for (String name : UI_FILES) {
                HttpURLConnection c = (HttpURLConnection) new URL(DEFAULT_UI_BASE + name + "?t=" + System.currentTimeMillis()).openConnection();
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
            runOnUiThread(this::loadUi);
        } catch (Exception ignored) {
            // No internet or repo not reachable yet: keep what's already bundled/cached.
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
}
