package com.aquatech.crm.sync

import androidx.room.*

/**
 * SyncDao — Data Access Object para operaciones sobre la cola de sync.
 * Room compila estas queries a SQL optimizado en tiempo de compilación.
 */
@Dao
interface SyncDao {
    
    // ─── Queries de lectura ──────────────────────────────
    
    @Query("SELECT * FROM sync_queue WHERE status IN ('PENDING', 'RETRY') ORDER BY priority DESC, createdAt ASC")
    fun getPendingItems(): List<SyncItem>
    
    @Query("SELECT * FROM sync_queue WHERE status = 'CONFLICT' ORDER BY createdAt ASC")
    fun getConflictItems(): List<SyncItem>
    
    @Query("SELECT * FROM sync_queue WHERE id = :id")
    fun getById(id: String): SyncItem?
    
    @Query("SELECT COUNT(*) FROM sync_queue WHERE status IN ('PENDING', 'RETRY', 'SYNCING')")
    fun getPendingCount(): Int
    
    @Query("SELECT COUNT(*) FROM sync_queue WHERE status = :status")
    fun getCountByStatus(status: String): Int
    
    @Query("SELECT COUNT(*) FROM sync_queue WHERE status = 'COMPLETED' AND lastAttemptAt >= :since")
    fun getCompletedSince(since: Long): Int
    
    @Query("SELECT MAX(lastAttemptAt) FROM sync_queue WHERE status = 'COMPLETED'")
    fun getLastCompletedTimestamp(): Long?
    
    @Query("""
        SELECT id, type, status, createdAt, errorMessage 
        FROM sync_queue 
        WHERE status IN ('PENDING', 'RETRY', 'SYNCING', 'FAILED', 'CONFLICT') 
        ORDER BY createdAt DESC 
        LIMIT 20
    """)
    fun getPendingItemsSummary(): List<SyncItemSummary>
    
    // ─── Operaciones de escritura ────────────────────────
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insert(item: SyncItem)
    
    @Update
    fun update(item: SyncItem)
    
    @Delete
    fun delete(item: SyncItem)
    
    @Query("DELETE FROM sync_queue WHERE status = 'COMPLETED' AND lastAttemptAt < :before")
    fun cleanupCompleted(before: Long)
    
    @Query("UPDATE sync_queue SET status = 'PENDING', attempts = 0, errorMessage = NULL WHERE id = :id")
    fun resetItem(id: String)
}

/**
 * Proyección ligera para el resumen de items (pantalla de diagnóstico).
 */
data class SyncItemSummary(
    val id: String,
    val type: String,
    val status: String,
    val createdAt: Long,
    val errorMessage: String?
)
