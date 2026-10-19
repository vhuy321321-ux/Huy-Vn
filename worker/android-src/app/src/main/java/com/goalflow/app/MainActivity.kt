package com.goalflow.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.widget.Toast
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import org.json.JSONObject
import org.json.JSONArray
import java.net.URL
import java.io.ByteArrayOutputStream
import javax.net.ssl.HttpsURLConnection

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var uploadMessage: ValueCallback<Array<Uri>>? = null
    private var pendingBackupJson: String? = null
    @Volatile private var notionSessionToken: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.allowFileAccessFromFileURLs = false
            settings.allowUniversalAccessFromFileURLs = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val uri = request?.url ?: return true
                    return !(uri.scheme == "file" && uri.path == "/android_asset/index.html")
                }
            }
            webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: WebChromeClient.FileChooserParams?
            ): Boolean {
                val callback = filePathCallback ?: return false
                this@MainActivity.uploadMessage?.onReceiveValue(null)
                this@MainActivity.uploadMessage = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                }
                return try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                    true
                } catch (_: Exception) {
                    this@MainActivity.uploadMessage?.onReceiveValue(null)
                    this@MainActivity.uploadMessage = null
                    false
                }
            }
        }
            addJavascriptInterface(GoalFlowBridge(this@MainActivity), "GoalFlowBridge")
        }
        setContentView(webView)
        if (savedInstanceState == null) {
            webView.loadUrl("file:///android_asset/index.html")
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        notionSessionToken = null
        super.onDestroy()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            FILE_CHOOSER_REQUEST -> {
                val uri = if (resultCode == RESULT_OK) data?.data else null
                uploadMessage?.onReceiveValue(uri?.let { arrayOf(it) })
                uploadMessage = null
            }
            BACKUP_REQUEST -> {
                val uri = if (resultCode == RESULT_OK) data?.data else null
                val json = pendingBackupJson
                if (uri != null && json != null) {
                    try {
                        contentResolver.openOutputStream(uri)?.use { output ->
                            output.write(json.toByteArray(Charsets.UTF_8))
                        } ?: throw IllegalStateException("Unable to open backup destination")
                        Toast.makeText(this, "Đã lưu bản sao lưu.", Toast.LENGTH_SHORT).show()
                    } catch (_: Exception) {
                        Toast.makeText(this, "Không thể lưu bản sao lưu.", Toast.LENGTH_LONG).show()
                    }
                }
                pendingBackupJson = null
            }
        }
    }

    internal fun requestBackupExport(json: String) {
        pendingBackupJson = json
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/json"
            putExtra(Intent.EXTRA_TITLE, "goalflow-backup.json")
        }
        try {
            startActivityForResult(intent, BACKUP_REQUEST)
        } catch (_: Exception) {
            pendingBackupJson = null
            Toast.makeText(this, "Không thể mở nơi lưu bản sao lưu.", Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        private const val FILE_CHOOSER_REQUEST = 4101
        private const val BACKUP_REQUEST = 4102
    }
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    class GoalFlowBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun exportBackup(json: String) {
            activity.runOnUiThread { activity.requestBackupExport(json) }
        }

        @JavascriptInterface
        fun notionRequest(requestId: String, workerUrl: String, path: String, method: String, body: String) {
            if (requestId.length > 64 || !requestId.matches(Regex("[A-Za-z0-9_-]+")) ||
                path !in setOf("/api/login", "/api/sync") || method != "POST" || body.toByteArray(Charsets.UTF_8).size > 1_000_000) {
                deliverNotion(requestId, 400, "{\"error\":\"invalid_request\"}")
                return
            }
            val endpoint = try {
                val uri = Uri.parse(workerUrl)
                if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null || uri.query != null || uri.fragment != null) throw IllegalArgumentException()
                URL(workerUrl.trimEnd('/') + path)
            } catch (_: Exception) {
                deliverNotion(requestId, 400, "{\"error\":\"invalid_worker_url\"}")
                return
            }
            Thread {
                var connection: HttpsURLConnection? = null
                try {
                    connection = (endpoint.openConnection() as HttpsURLConnection).apply {
                        requestMethod = method
                        connectTimeout = 10_000
                        readTimeout = 20_000
                        instanceFollowRedirects = false
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        if (path == "/api/sync") {
                            val token = activity.notionSessionToken
                            if (token.isNullOrBlank()) throw IllegalStateException("SESSION_REQUIRED")
                            setRequestProperty("Authorization", "Bearer $token")
                        }
                    }
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    val status = connection.responseCode
                    val stream = if (status >= 400) connection.errorStream else connection.inputStream
                    val response = stream?.use { input ->
                        val output = ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        var total = 0
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            if (total > 1_000_000) throw IllegalStateException("RESPONSE_TOO_LARGE")
                            output.write(buffer, 0, count)
                        }
                        output.toString(Charsets.UTF_8.name())
                    } ?: "{}"
                    if (path == "/api/login" && status == 200) {
                        val result = JSONObject(response)
                        val token = result.optString("token", "")
                        if (token.isBlank()) throw IllegalStateException("SESSION_MISSING")
                        activity.notionSessionToken = token
                        val sanitized = JSONObject().put("authenticated", true).put("expiresIn", result.optInt("expiresIn", 0)).toString()
                        deliverNotion(requestId, status, sanitized)
                    } else {
                        if (status == 401) activity.notionSessionToken = null
                        deliverNotion(requestId, status, response)
                    }
                } catch (_: Exception) {
                    deliverNotion(requestId, 0, "{\"error\":\"network_error\"}")
                } finally {
                    connection?.disconnect()
                }
            }.start()
        }

        private fun deliverNotion(requestId: String, status: Int, body: String) {
            activity.runOnUiThread {
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                val callback = "window.onGoalFlowNotionResponse(${JSONObject.quote(requestId)},$status,${JSONObject.quote(body)})"
                activity.webView.evaluateJavascript(callback, null)
            }
        }

        @JavascriptInterface
        fun sync(json: String) {
            try {
                val obj = JSONObject(json)
                val arr = obj.optJSONArray("tasks") ?: JSONArray()
                val tasks = (0 until arr.length()).mapNotNull { i ->
                    val item = arr.optJSONObject(i) ?: return@mapNotNull null
                    GoalTask(
                        id = item.optString("id", ""),
                        title = item.optString("title", ""),
                        dueDate = item.optString("date", item.optString("dueDate", "")),
                        done = item.optBoolean("done", false),
                        parentTaskId = item.optString("parentTaskId", "")
                    )
                }
                val plan = GoalPlan(
                    title = obj.optString("goal", obj.optString("title", "Mục tiêu của bạn")),
                    deadline = obj.optString("deadline", ""),
                    tasks = tasks
                )
                activity.runOnUiThread { GoalData.save(activity, plan) }
            } catch (_: Exception) {
                // Ignore malformed or incomplete data rather than crashing the app.
            }
        }
    }
}
