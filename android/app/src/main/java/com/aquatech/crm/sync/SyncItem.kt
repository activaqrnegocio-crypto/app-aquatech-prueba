package com.aquatech.crm.sync

import androidx.room.*

/**
 * SyncItem — Entidad de Room DB para la cola de sincronización.
 * Reemplaza el outbox de IndexedDB cuando corre en la app nativa.
 * 
 * Room DB (SQLite nativo) NO sufre storage eviction de Chrome.
 * Los datos solo se borran si el usuario desinstala la app o limpia datos manualmente.
 */
@Entity(tableName = "sync_queue")
data class SyncItem(
    @PrimaryKey val id: String = java.util.UUID.randomUUID().toString(),
    
    // Tipo de operación (mapea a OutboxItem.type del TypeScript)
    val type: String,  // TASK, GALLERY_UPLOAD, MESSAGE, PROJECT, etc.
    
    // API endpoint relativo, e.g. "/api/appointments" o "/api/appointments/123"
    val endpoint: String,
    
    // Método HTTP: POST, PATCH, PUT, DELETE
    val method: String,
    
    // JSON del payload (sin archivos binarios)
    val payloadJson: String,
    
    // Paths locales de archivos para subir a BunnyCDN
    // JSON array: ["/data/.../foto1.jpg", "/data/.../foto2.jpg"]
    val filesPaths: String? = null,
    
    // Idempotency key — evita duplicados en el servidor
    val syncId: String = java.util.UUID.randomUUID().toString(),
    
    // Estado actual del item
    // PENDING, SYNCING, COMPLETED, RETRY, FAILED, CONFLICT, AUTH_REQUIRED
    val status: String = "PENDING",
    
    // Número de intentos realizados
    val attempts: Int = 0,
    
    // Máximo de reintentos antes de marcar como FAILED
    val maxAttempts: Int = 5,
    
    // Prioridad: 0=normal, 1=high, 2=critical
    val priority: Int = 0,
    
    // Timestamp de cuando el usuario hizo la edición original
    val editedAt: Long = System.currentTimeMillis(),
    
    // Timestamp de la creación del item en la cola
    val createdAt: Long = System.currentTimeMillis(),
    
    // Timestamp del último intento de sync
    val lastAttemptAt: Long? = null,
    
    // Mensaje de error del último intento fallido
    val errorMessage: String? = null,
    
    // ID del proyecto asociado (para agrupar y filtrar)
    val projectId: Int = 0,
    
    // Datos del servidor en caso de conflicto (para mostrar al usuario)
    val serverData: String? = null
)
