package com.aquatech.crm.sync

import android.content.Context
import android.util.Log
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import java.util.UUID

/**
 * MigrationPlugin — Capacitor plugin to handle the one-time data migration
 * from browser IndexedDB queue to Room DB when upgrading to the native app.
 */
@CapacitorPlugin(name = "Migration")
class MigrationPlugin : Plugin() {

    private val scope = CoroutineScope(Dispatchers.IO)

    @PluginMethod
    fun checkAndMigrate(call: PluginCall) {
        try {
            val prefs = context.getSharedPreferences("aquatech_mig", Context.MODE_PRIVATE)
            val migrated = prefs.getBoolean("idb_migrated", false)
            
            val res = JSObject()
            res.put("needsMigration", !migrated)
            call.resolve(res)
        } catch (e: Exception) {
            call.reject("Error checking migration: ${e.message}")
        }
    }

    @PluginMethod
    fun importOutboxItems(call: PluginCall) {
        val itemsArray = call.getArray("items") ?: return call.reject("Missing items array")
        
        scope.launch {
            try {
                val db = AquatechDatabase.getInstance(context)
                var importedCount = 0
                
                for (i in 0 until itemsArray.length()) {
                    val obj = itemsArray.getJSONObject(i)
                    val type = obj.getString("type")
                    val projectId = obj.optInt("projectId", 0)
                    val payload = obj.getString("payload")
                    val syncId = obj.optString("syncId", UUID.randomUUID().toString())
                    
                    // Determine endpoint and method based on type or existing conventions
                    val method = if (obj.optString("status", "pending") == "pending") "POST" else "PATCH"
                    
                    val endpoint = when (type) {
                        "TASK" -> "/api/appointments"
                        "MESSAGE" -> "/api/chat"
                        "GALLERY_UPLOAD" -> "/api/projects/gallery"
                        "PROJECT" -> "/api/projects"
                        else -> "/api/offline-sync"
                    }

                    val item = SyncItem(
                        type = type,
                        projectId = projectId,
                        payloadJson = payload,
                        endpoint = endpoint,
                        method = method,
                        syncId = syncId,
                        status = "PENDING"
                    )
                    db.syncDao().insert(item)
                    importedCount++
                }

                val res = JSObject()
                res.put("imported", importedCount)
                call.resolve(res)
            } catch (e: Exception) {
                Log.e("MigrationPlugin", "Migration failed", e)
                call.reject("Migration failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun markComplete(call: PluginCall) {
        try {
            val prefs = context.getSharedPreferences("aquatech_mig", Context.MODE_PRIVATE)
            prefs.edit().putBoolean("idb_migrated", true).apply()
            call.resolve()
        } catch (e: Exception) {
            call.reject("Error marking migration: ${e.message}")
        }
    }
}
