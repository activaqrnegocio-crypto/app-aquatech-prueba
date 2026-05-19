package com.aquatech.crm.sync

import android.content.Context
import androidx.room.*

/**
 * AquatechDatabase — Base de datos Room (SQLite) para la app nativa.
 * 
 * Esta DB almacena la cola de sincronización y se usa ÚNICAMENTE
 * en la app nativa (Capacitor). La PWA web sigue usando IndexedDB.
 * 
 * Room DB vive en: /data/data/com.aquatech.crm/databases/aquatech_sync.db
 * Android NUNCA borra esto por storage pressure (a diferencia de IndexedDB en Chrome).
 */
@Database(
    entities = [SyncItem::class],
    version = 1,
    exportSchema = false
)
abstract class AquatechDatabase : RoomDatabase() {
    
    abstract fun syncDao(): SyncDao
    
    companion object {
        @Volatile
        private var INSTANCE: AquatechDatabase? = null
        
        fun getInstance(context: Context): AquatechDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AquatechDatabase::class.java,
                    "aquatech_sync.db"
                )
                .fallbackToDestructiveMigration() // Si cambia el schema, recrea la DB
                .build()
                INSTANCE = instance
                instance
            }
        }
    }
}
