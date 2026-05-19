package com.aquatech.crm.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * SyncBridgePlugin — Puente Capacitor entre WebView (TypeScript) y Kotlin nativo.
 * 
 * Este plugin recibe llamadas desde native-bridge.ts y:
 * 1. Guarda los items en Room DB (SQLite nativo)
 * 2. Guarda archivos binarios en el filesystem nativo
 * 3. Arranca el SyncForegroundService para procesar la cola
 * 4. Reporta el estado de sync al WebView
 */
@CapacitorPlugin(
    name = "SyncBridge",
    permissions = [
        Permission(
            alias = "notifications",
            strings = [android.Manifest.permission.POST_NOTIFICATIONS]
        )
    ]
)
class SyncBridgePlugin : Plugin() {
    
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    
    companion object {
        private const val TAG = "SyncBridge"
    }

    private val syncReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == "com.aquatech.crm.SYNC_EVENT") {
                val syncId = intent.getStringExtra("syncId") ?: ""
                val status = intent.getStringExtra("status") ?: ""
                val errorMessage = intent.getStringExtra("errorMessage")
                val serverData = intent.getStringExtra("serverData")
                
                val event = JSObject().apply {
                    put("syncId", syncId)
                    put("status", status)
                    if (errorMessage != null) put("errorMessage", errorMessage)
                    if (serverData != null) put("serverData", serverData)
                }
                notifyListeners("syncEvent", event)
            }
        }
    }

    override fun load() {
        super.load()
        val filter = IntentFilter("com.aquatech.crm.SYNC_EVENT")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(syncReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(syncReceiver, filter)
        }
    }

    
    /**
     * Encola un item para sincronización.
     * Llamado desde: SyncBridge.enqueue() en native-bridge.ts
     */
    @PluginMethod
    fun enqueue(call: PluginCall) {
        val type = call.getString("type") ?: return call.reject("Missing type")
        val endpoint = call.getString("endpoint") ?: return call.reject("Missing endpoint")
        val method = call.getString("method") ?: return call.reject("Missing method")
        val payloadJson = call.getString("payloadJson") ?: return call.reject("Missing payloadJson")
        val syncId = call.getString("syncId") ?: UUID.randomUUID().toString()
        val projectId = call.getInt("projectId") ?: 0
        val priority = call.getInt("priority") ?: 0
        val editedAt = call.getLong("editedAt") ?: System.currentTimeMillis()
        
        scope.launch {
            try {
                val db = AquatechDatabase.getInstance(context)
                val item = SyncItem(
                    type = type,
                    endpoint = endpoint,
                    method = method,
                    payloadJson = payloadJson,
                    syncId = syncId,
                    projectId = projectId,
                    priority = priority,
                    editedAt = editedAt
                )
                db.syncDao().insert(item)
                
                Log.i(TAG, "Enqueued sync item: type=$type, id=${item.id}")
                
                // Arrancar el Foreground Service para procesar la cola
                startSyncService()
                
                val result = JSObject()
                result.put("id", item.id)
                result.put("status", "PENDING")
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to enqueue item", e)
                call.reject("Failed to enqueue: ${e.message}")
            }
        }
    }
    
    /**
     * Guarda un archivo binario en el filesystem nativo y retorna su path local.
     * El archivo se vincula a un SyncItem para subir a BunnyCDN.
     */
    @PluginMethod
    fun enqueueFile(call: PluginCall) {
        val fileBase64 = call.getString("fileBase64") ?: return call.reject("Missing fileBase64")
        val filename = call.getString("filename") ?: "file_${System.currentTimeMillis()}"
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        val linkedSyncId = call.getString("linkedSyncId") ?: ""
        
        scope.launch {
            try {
                // Decodificar base64 a bytes
                val bytes = Base64.decode(fileBase64, Base64.DEFAULT)
                
                // Guardar en el directorio privado de la app
                val pendingDir = File(context.filesDir, "pending")
                pendingDir.mkdirs()
                val safeName = filename.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                val file = File(pendingDir, "${System.currentTimeMillis()}_$safeName")
                file.writeBytes(bytes)
                
                Log.i(TAG, "File saved: ${file.absolutePath} (${bytes.size} bytes)")
                
                // Si hay un SyncItem vinculado, agregar la ruta del archivo
                if (linkedSyncId.isNotEmpty()) {
                    val db = AquatechDatabase.getInstance(context)
                    val syncItem = db.syncDao().getById(linkedSyncId)
                    if (syncItem != null) {
                        val existingPaths = syncItem.filesPaths?.let { JSONArray(it) } ?: JSONArray()
                        existingPaths.put(file.absolutePath)
                        db.syncDao().update(syncItem.copy(filesPaths = existingPaths.toString()))
                    }
                }
                
                val result = JSObject()
                result.put("filePath", file.absolutePath)
                result.put("size", bytes.size)
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to save file", e)
                call.reject("Failed to save file: ${e.message}")
            }
        }
    }
    
    /**
     * Obtiene el estado actual de la cola de sincronización.
     * Llamado desde: SyncBridge.getStatus() en native-bridge.ts
     */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        scope.launch {
            try {
                val db = AquatechDatabase.getInstance(context)
                val dao = db.syncDao()
                
                val todayStart = java.util.Calendar.getInstance().apply {
                    set(java.util.Calendar.HOUR_OF_DAY, 0)
                    set(java.util.Calendar.MINUTE, 0)
                    set(java.util.Calendar.SECOND, 0)
                    set(java.util.Calendar.MILLISECOND, 0)
                }.timeInMillis
                
                val networkMonitor = NetworkMonitor(context)
                val networkInfo = networkMonitor.getInfo()
                
                val result = JSObject()
                result.put("pending", dao.getCountByStatus("PENDING") + dao.getCountByStatus("RETRY"))
                result.put("syncing", dao.getCountByStatus("SYNCING"))
                result.put("completed", dao.getCountByStatus("COMPLETED"))
                result.put("failed", dao.getCountByStatus("FAILED"))
                result.put("conflicts", dao.getCountByStatus("CONFLICT"))
                result.put("completedToday", dao.getCompletedSince(todayStart))
                result.put("lastSyncAt", dao.getLastCompletedTimestamp() ?: JSONObject.NULL)
                result.put("networkType", networkInfo.type)
                result.put("networkSpeed", networkInfo.speedKbps)
                
                // Agregar resumen de items pendientes
                val summaries = dao.getPendingItemsSummary()
                val itemsArray = JSONArray()
                for (s in summaries) {
                    val obj = JSONObject()
                    obj.put("id", s.id)
                    obj.put("type", s.type)
                    obj.put("status", s.status)
                    obj.put("createdAt", s.createdAt)
                    obj.put("errorMessage", s.errorMessage ?: JSONObject.NULL)
                    itemsArray.put(obj)
                }
                result.put("pendingItems", itemsArray)
                
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to get status", e)
                call.reject("Failed to get status: ${e.message}")
            }
        }
    }
    
    /**
     * Fuerza la sincronización inmediata.
     */
    @PluginMethod
    fun forceSync(call: PluginCall) {
        startSyncService()
        call.resolve()
    }
    
    /**
     * Resuelve un conflicto de datos.
     */
    @PluginMethod
    fun resolveConflict(call: PluginCall) {
        val syncItemId = call.getString("syncItemId") ?: return call.reject("Missing syncItemId")
        val resolution = call.getString("resolution") ?: return call.reject("Missing resolution")
        
        scope.launch {
            try {
                val db = AquatechDatabase.getInstance(context)
                val item = db.syncDao().getById(syncItemId) ?: return@launch call.reject("Item not found")
                
                when (resolution) {
                    "USE_LOCAL" -> {
                        // El usuario quiere usar su versión — reenviar con force flag
                        db.syncDao().update(item.copy(
                            status = "PENDING",
                            attempts = 0,
                            errorMessage = null,
                            serverData = null
                        ))
                        startSyncService()
                    }
                    "USE_SERVER" -> {
                        // El usuario descarta su cambio
                        db.syncDao().update(item.copy(
                            status = "COMPLETED",
                            errorMessage = "Descartado por el usuario (usó versión del servidor)"
                        ))
                    }
                }
                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to resolve conflict: ${e.message}")
            }
        }
    }
    
    /**
     * Verifica si la app nativa tiene permiso de notificaciones (Android 13+).
     */
    @PluginMethod
    fun checkNotificationPermission(call: PluginCall) {
        val res = JSObject()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val state = getPermissionState("notifications")
            res.put("granted", state == PermissionState.GRANTED)
        } else {
            res.put("granted", true)
        }
        call.resolve(res)
    }

    /**
     * Solicita el permiso nativo de notificaciones al sistema Android (Android 13+).
     */
    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val state = getPermissionState("notifications")
            if (state != PermissionState.GRANTED) {
                requestPermissionForAlias("notifications", call, "notificationsCallback")
            } else {
                val res = JSObject()
                res.put("granted", true)
                call.resolve(res)
            }
        } else {
            val res = JSObject()
            res.put("granted", true)
            call.resolve(res)
        }
    }

    @PermissionCallback
    fun notificationsCallback(call: PluginCall) {
        val res = JSObject()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val state = getPermissionState("notifications")
            res.put("granted", state == PermissionState.GRANTED)
        } else {
            res.put("granted", true)
        }
        call.resolve(res)
    }

    /**
     * Retorna la versión nativa del paquete APK actual (versionName y versionCode).
     */
    @PluginMethod
    fun getAppVersion(call: PluginCall) {
        val res = JSObject()
        try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val versionName = pInfo.versionName ?: "1.0.0"
            val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                pInfo.longVersionCode
            } else {
                pInfo.versionCode.toLong()
            }
            res.put("version", versionName)
            res.put("build", versionCode)
        } catch (e: Exception) {
            res.put("version", "1.0.0")
            res.put("build", 1)
        }
        call.resolve(res)
    }
    
    /**
     * Arranca el SyncForegroundService.
     * Usa startForegroundService() para garantizar que Android no lo mate.
     */
    private fun startSyncService() {
        try {
            val intent = Intent(context, SyncForegroundService::class.java)
            ContextCompat.startForegroundService(context, intent)
            Log.i(TAG, "SyncForegroundService started")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start SyncForegroundService", e)
        }
    }
    
    override fun handleOnDestroy() {
        scope.cancel()
        try {
            context.unregisterReceiver(syncReceiver)
        } catch (e: Exception) {
            // Already unregistered or not registered
        }
        super.handleOnDestroy()
    }
}
