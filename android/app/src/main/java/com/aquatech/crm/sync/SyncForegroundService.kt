package com.aquatech.crm.sync

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * SyncForegroundService — Servicio nativo de Android para sincronización.
 * 
 * CLAVE: Un Foreground Service con notificación visible NO puede ser matado
 * por Android (excepto en situaciones extremas de batería <5%).
 * Es la misma tecnología que usan WhatsApp, Spotify y Google Maps.
 * 
 * Este servicio:
 * 1. Lee items PENDING de Room DB
 * 2. Sube archivos a BunnyCDN usando OkHttp (nativo, sin límite de tiempo)
 * 3. Envía datos al API del VPS
 * 4. Maneja errores granulares (401, 409, 413, 5xx)
 * 5. Notifica progreso al WebView
 * 6. Se detiene automáticamente cuando no hay más items
 */
class SyncForegroundService : Service() {
    
    companion object {
        private const val TAG = "SyncService"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "aquatech_sync"
        
        // ─── Configuración BunnyCDN ───
        // TODO: Mover a BuildConfig o SharedPreferences (seguridad)
        private const val BUNNY_STORAGE_HOST = "storage.bunnycdn.com"
        private const val BUNNY_STORAGE_ZONE = "aquatech-crm-media"
        private const val BUNNY_ACCESS_KEY = "" // Se configura en runtime
        private const val BUNNY_PULL_ZONE = "" // Se configura en runtime
        
        // ─── Base URL del API ───
        private const val BASE_URL = "https://178.238.238.158.sslip.io"
        
        fun start(context: Context) {
            val intent = Intent(context, SyncForegroundService::class.java)
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
        }
    }
    
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.MINUTES)  // 10 min para archivos grandes
        .readTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    
    override fun onBind(intent: Intent?): IBinder? = null
    
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }
    
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = createNotification("Preparando sincronización...")
        
        // FOREGROUND_SERVICE_TYPE_DATA_SYNC para Android 14+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, 
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        
        scope.launch {
            try {
                processQueue()
            } catch (e: Exception) {
                Log.e(TAG, "Sync queue processing failed", e)
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        
        return START_STICKY  // Si Android lo mata, lo reinicia
    }
    
    /**
     * Procesa la cola de sincronización item por item.
     */
    private suspend fun processQueue() {
        val db = AquatechDatabase.getInstance(this)
        val items = db.syncDao().getPendingItems()
        
        if (items.isEmpty()) {
            Log.i(TAG, "No pending items, stopping")
            return
        }
        
        Log.i(TAG, "Processing ${items.size} pending items")
        
        for ((index, item) in items.withIndex()) {
            // Verificar conexión antes de cada item
            if (!NetworkMonitor(this).isConnected()) {
                Log.w(TAG, "Lost connection, stopping sync")
                updateNotification("Sin conexión — ${items.size - index} items pendientes")
                break
            }
            
            updateNotification("Sincronizando ${index + 1}/${items.size}: ${item.type}")
            db.syncDao().update(item.copy(
                status = "SYNCING", 
                lastAttemptAt = System.currentTimeMillis()
            ))
            notifyWebview(item.syncId, "SYNCING")
            
            try {
                processItem(item, db)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to process item ${item.id}", e)
                val newAttempts = item.attempts + 1
                val status = if (newAttempts >= item.maxAttempts) "FAILED" else "RETRY"
                db.syncDao().update(item.copy(
                    status = status,
                    attempts = newAttempts,
                    lastAttemptAt = System.currentTimeMillis(),
                    errorMessage = e.message ?: "Unknown error"
                ))
                notifyWebview(item.syncId, status, e.message ?: "Unknown error")
            }
        }
        
        val remaining = db.syncDao().getPendingCount()
        if (remaining == 0) {
            updateNotification("✅ Sincronización completada")
        } else {
            updateNotification("⚠️ $remaining items pendientes")
        }
        
        // Pequeña pausa para que el usuario vea la notificación final
        delay(2000)
    }
    
    /**
     * Procesa un item individual: sube archivos + envía al API.
     */
    private suspend fun processItem(item: SyncItem, db: AquatechDatabase) {
        val uploadedUrls = mutableMapOf<String, String>()
        
        // 1. Subir archivos a BunnyCDN si existen
        if (!item.filesPaths.isNullOrEmpty()) {
            val filePaths = JSONArray(item.filesPaths)
            for (i in 0 until filePaths.length()) {
                val localPath = filePaths.getString(i)
                val file = File(localPath)
                if (file.exists()) {
                    updateNotification("Subiendo archivo ${i + 1}/${filePaths.length()}...")
                    val url = uploadToBunny(file)
                    uploadedUrls[localPath] = url
                    Log.i(TAG, "Uploaded: $localPath → $url")
                } else {
                    Log.w(TAG, "File not found: $localPath")
                }
            }
        }
        
        // 2. Reemplazar paths locales con URLs de CDN en el payload
        var payload = item.payloadJson
        for ((local, remote) in uploadedUrls) {
            payload = payload.replace(local, remote)
        }
        
        // 3. Enviar al API
        val requestBuilder = Request.Builder()
            .url("$BASE_URL${item.endpoint}")
            .header("Content-Type", "application/json")
            .header("x-sync-id", item.syncId)
        
        when (item.method) {
            "POST" -> requestBuilder.post(payload.toRequestBody("application/json".toMediaType()))
            "PATCH" -> requestBuilder.patch(payload.toRequestBody("application/json".toMediaType()))
            "PUT" -> requestBuilder.put(payload.toRequestBody("application/json".toMediaType()))
            "DELETE" -> requestBuilder.delete(payload.toRequestBody("application/json".toMediaType()))
        }
        
        val response = client.newCall(requestBuilder.build()).execute()
        handleResponse(response, item, db, uploadedUrls)
    }
    
    /**
     * Maneja la respuesta del API con errores granulares.
     */
    private fun handleResponse(
        response: Response, 
        item: SyncItem, 
        db: AquatechDatabase,
        uploadedUrls: Map<String, String>
    ) {
        when {
            response.isSuccessful -> {
                db.syncDao().update(item.copy(
                    status = "COMPLETED",
                    lastAttemptAt = System.currentTimeMillis()
                ))
                // Limpiar archivos locales
                for (local in uploadedUrls.keys) {
                    File(local).delete()
                }
                Log.i(TAG, "✅ Item ${item.id} synced successfully")
                notifyWebview(item.syncId, "COMPLETED")
            }
            
            response.code == 401 -> {
                // Token expirado — marcar para re-auth
                Log.w(TAG, "Auth expired for item ${item.id}")
                db.syncDao().update(item.copy(
                    status = "AUTH_REQUIRED",
                    errorMessage = "Sesión expirada — inicia sesión de nuevo"
                ))
                notifyWebview(item.syncId, "AUTH_REQUIRED", "Sesión expirada — inicia sesión de nuevo")
            }
            
            response.code == 409 -> {
                // Conflicto — el servidor tiene una versión más reciente
                val serverData = response.body?.string()
                Log.w(TAG, "Conflict for item ${item.id}")
                db.syncDao().update(item.copy(
                    status = "CONFLICT",
                    errorMessage = "Conflicto: datos modificados en el servidor",
                    serverData = serverData
                ))
                notifyWebview(item.syncId, "CONFLICT", "Conflicto: datos modificados en el servidor", serverData)
            }
            
            response.code == 413 -> {
                // Payload demasiado grande
                db.syncDao().update(item.copy(
                    status = "FAILED",
                    errorMessage = "Archivo demasiado grande"
                ))
                notifyWebview(item.syncId, "FAILED", "Archivo demasiado grande")
            }
            
            response.code in 400..499 -> {
                // Otros errores del cliente — no reintentar
                val body = response.body?.string() ?: ""
                db.syncDao().update(item.copy(
                    status = "FAILED",
                    errorMessage = "Error ${response.code}: $body"
                ))
                notifyWebview(item.syncId, "FAILED", "Error ${response.code}: $body")
            }
            
            response.code in 500..599 -> {
                // Error del servidor — reintentar con backoff
                val newAttempts = item.attempts + 1
                val status = if (newAttempts >= item.maxAttempts) "FAILED" else "RETRY"
                db.syncDao().update(item.copy(
                    status = status,
                    attempts = newAttempts,
                    lastAttemptAt = System.currentTimeMillis(),
                    errorMessage = "Error del servidor: ${response.code}"
                ))
                notifyWebview(item.syncId, status, "Error del servidor: ${response.code}")
            }
        }
    }

    /**
     * Envía un Broadcast local para notificar el progreso al WebView
     */
    private fun notifyWebview(syncId: String, status: String, error: String? = null, serverData: String? = null) {
        val intent = Intent("com.aquatech.crm.SYNC_EVENT").apply {
            putExtra("syncId", syncId)
            putExtra("status", status)
            if (error != null) putExtra("errorMessage", error)
            if (serverData != null) putExtra("serverData", serverData)
        }
        sendBroadcast(intent)
    }
    
    /**
     * Sube un archivo a BunnyCDN.
     * Usa OkHttp nativo — sin límite de tiempo, con retry automático.
     */
    private fun uploadToBunny(file: File): String {
        val timestamp = System.currentTimeMillis()
        val safeName = file.name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        val path = "/$BUNNY_STORAGE_ZONE/pending/${timestamp}-${safeName}"
        
        // Leer las claves de las SharedPreferences (se configuran al primer login)
        val prefs = getSharedPreferences("aquatech_config", MODE_PRIVATE)
        val accessKey = prefs.getString("bunny_access_key", BUNNY_ACCESS_KEY) ?: BUNNY_ACCESS_KEY
        val pullZone = prefs.getString("bunny_pull_zone", BUNNY_PULL_ZONE) ?: BUNNY_PULL_ZONE
        
        val request = Request.Builder()
            .url("https://$BUNNY_STORAGE_HOST$path")
            .put(file.asRequestBody())
            .header("AccessKey", accessKey)
            .build()
        
        val response = client.newCall(request).execute()
        if (!response.isSuccessful) {
            throw java.io.IOException("Bunny upload failed: ${response.code} ${response.message}")
        }
        
        return "$pullZone/pending/${timestamp}-${safeName}"
    }
    
    // ─── Notification helpers ───────────────────────────────────────────
    
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Sincronización Aquatech",
                NotificationManager.IMPORTANCE_LOW  // Sin sonido, solo visual
            ).apply {
                description = "Progreso de sincronización de datos"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
    
    private fun createNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Aquatech CRM")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
    
    private fun updateNotification(text: String) {
        val notification = createNotification(text)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification)
    }
    
    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
