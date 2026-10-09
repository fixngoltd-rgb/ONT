package com.fixngo.board;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.Manifest;
import android.content.pm.PackageManager;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
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

    // File chooser state (WebView needs the host app to implement onShowFileChooser,
    // otherwise every <input type=file> silently does nothing).
    private static final int REQ_FILE = 4711;
    private static final int REQ_CAM_PERM = 4712;
    private ValueCallback<Uri[]> filePathCallback;
    private WebChromeClient.FileChooserParams pendingParams;
    private Uri cameraUri;

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

        // Android's default overscroll glow paints a translucent arc at the edge being
        // overscrolled. With a horizontally-swiping pager sitting right below a fixed
        // header, a diagonal thumb movement can trigger that glow at the top edge and
        // it visually smears across the header during the swipe. Not needed here.
        web.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                pendingParams = params;
                boolean camera = params.isCaptureEnabled();
                if (camera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM_PERM);
                    return true;
                }
                launchChooser(camera);
                return true;
            }
        });
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

    private void launchChooser(boolean camera) {
        try {
            Intent pick = pendingParams.createIntent();
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                    pendingParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
            Intent chooser;
            if (camera) {
                File dir = new File(getCacheDir(), "camera");
                dir.mkdirs();
                File photo = File.createTempFile("photo_", ".jpg", dir);
                cameraUri = androidx.core.content.FileProvider.getUriForFile(
                        this, getPackageName() + ".fileprovider", photo);
                Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                chooser = Intent.createChooser(cam, "Add photo");
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{pick});
            } else {
                cameraUri = null;
                chooser = pick;
            }
            startActivityForResult(chooser, REQ_FILE);
        } catch (Exception e) {
            if (filePathCallback != null) filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_CAM_PERM && filePathCallback != null) {
            // Granted -> camera; denied -> still let them pick a file.
            launchChooser(results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED);
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) { super.onActivityResult(req, res, data); return; }
        if (filePathCallback == null) return;
        Uri[] out = null;
        if (res == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) {
                out = new Uri[]{data.getData()};
            } else if (cameraUri != null) {
                out = new Uri[]{cameraUri};
            }
        }
        filePathCallback.onReceiveValue(out);
        filePathCallback = null;
        cameraUri = null;
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
