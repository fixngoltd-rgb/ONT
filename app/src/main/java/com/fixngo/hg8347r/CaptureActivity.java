package com.fixngo.hg8347r;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.app.AlertDialog;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Opens the original router portal and records what its pages send (XHR, fetch, form posts),
 * so new features can be built without a computer. Passwords and keys are masked.
 */
public class CaptureActivity extends Activity {

    private WebView web;
    private ScrollView logScroll;
    private TextView logView;
    private Button logBtn;
    private final List<String> entries = new ArrayList<>();
    private final Set<String> seen = new HashSet<>();
    private boolean logShown = false;
    private ConnectivityManager cm;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        SharedPreferences prefs = getSharedPreferences("hg8347r", MODE_PRIVATE);
        String host = prefs.getString("host", "192.168.100.1");

        cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    cm.bindProcessToNetwork(n);
                    break;
                }
            }
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(8, 8, 8, 8);
        logBtn = new Button(this);
        Button copy = new Button(this);
        Button clear = new Button(this);
        Button close = new Button(this);
        logBtn.setText("Log (0)");
        copy.setText("Copy");
        clear.setText("Clear");
        close.setText("Close");
        for (Button x : new Button[]{logBtn, copy, clear, close}) {
            x.setAllCaps(false);
            bar.addView(x, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
        root.addView(bar);

        FrameLayout body = new FrameLayout(this);
        web = new WebView(this);
        body.addView(web, new FrameLayout.LayoutParams(-1, -1));
        logView = new TextView(this);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextSize(11f);
        logView.setPadding(16, 16, 16, 16);
        logView.setTextIsSelectable(true);
        logScroll = new ScrollView(this);
        logScroll.setBackgroundColor(0xFFFFFFFF);
        logScroll.addView(logView);
        logScroll.setVisibility(View.GONE);
        body.addView(logScroll, new FrameLayout.LayoutParams(-1, -1));
        root.addView(body, new LinearLayout.LayoutParams(-1, 0, 1f));
        setContentView(root);

        logBtn.setOnClickListener(v -> toggleLog());
        copy.setOnClickListener(v -> {
            ClipboardManager cb = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cb.setPrimaryClip(ClipData.newPlainText("capture", allText()));
            Toast.makeText(this, "Copied " + entries.size() + " requests", Toast.LENGTH_SHORT).show();
        });
        clear.setOnClickListener(v -> { synchronized (entries) { entries.clear(); seen.clear(); } refreshLog(); });
        close.setOnClickListener(v -> finish());

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUserAgentString("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
        web.addJavascriptInterface(new Cap(), "CAP");

        final String hook = readHook();
        boolean docStart = false;
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                Set<String> origins = new HashSet<>(Collections.singletonList("http://" + host));
                WebViewCompat.addDocumentStartJavaScript(web, hook, origins);
                docStart = true;
            }
        } catch (Exception ignored) { }
        final boolean viaDocStart = docStart;
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                if (!viaDocStart) v.evaluateJavascript(hook, null);
            }
        });
        // Without this, WebView silently answers "No" to the portal's confirm() boxes, so Delete never runs.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView v, String url, String message, JsResult r) {
                new AlertDialog.Builder(CaptureActivity.this).setMessage(message)
                        .setPositiveButton("OK", (d, w) -> r.confirm())
                        .setOnCancelListener(d -> r.cancel()).show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, JsResult r) {
                new AlertDialog.Builder(CaptureActivity.this).setMessage(message)
                        .setPositiveButton("OK", (d, w) -> r.confirm())
                        .setNegativeButton("Cancel", (d, w) -> r.cancel())
                        .setOnCancelListener(d -> r.cancel()).show();
                return true;
            }
        });
        web.loadUrl("http://" + host + "/");
    }

    private String readHook() {
        try (InputStream in = getAssets().open("capture-hook.js")) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private String allText() {
        StringBuilder sb = new StringBuilder();
        synchronized (entries) { for (String e : entries) sb.append(e).append("\n\n"); }
        return sb.toString();
    }

    private void toggleLog() {
        logShown = !logShown;
        logScroll.setVisibility(logShown ? View.VISIBLE : View.GONE);
        logBtn.setText(logShown ? "Back to portal" : "Log (" + entries.size() + ")");
        refreshLog();
    }

    private void refreshLog() {
        runOnUiThread(() -> {
            if (logShown) logView.setText(allText());
            else logBtn.setText("Log (" + entries.size() + ")");
        });
    }

    @Override
    public void onBackPressed() {
        if (logShown) toggleLog();
        else if (web.canGoBack()) web.goBack();
        else finish();
    }

    @Override
    protected void onDestroy() {
        if (cm != null) cm.bindProcessToNetwork(null);
        super.onDestroy();
    }

    private class Cap {
        @JavascriptInterface
        public void log(String json) {
            try {
                JSONObject o = new JSONObject(json);
                String u = o.optString("u").replaceAll("([?&])_=\\d+", "$1");
                if (u.contains("refreshTime.asp") || u.contains("StartFileLoad")) return;
                String key = o.optString("m") + " " + u + " " + o.optString("b");
                synchronized (entries) {
                    if (!seen.add(key)) return;
                    StringBuilder sb = new StringBuilder();
                    sb.append(o.optString("m")).append(' ').append(u);
                    String b = o.optString("b");
                    if (!b.isEmpty()) sb.append("\n  body: ").append(b);
                    int st = o.optInt("s", 0);
                    if (st != 0) sb.append("\n  status: ").append(st);
                    String r = o.optString("r");
                    if (!r.isEmpty()) sb.append("\n  reply: ").append(r);
                    entries.add(sb.toString());
                }
                refreshLog();
            } catch (Exception ignored) { }
        }
    }
}
