package com.aquatech.crm.sync

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * SyncWorker — WorkManager periodic task.
 * 
 * Se ejecuta cada 15 minutos INCLUSO con la app cerrada.
 * Sobrevive reinicios del teléfono.
 * Si hay items pendientes en Room DB → arranca el SyncForegroundService.
 */
class SyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {
    
    companion object {
        private const val TAG = "SyncWorker"
        private const val WORK_NAME = "aquatech_periodic_sync"
        
        /**
         * Programa el sync periódico. Llamar en Application.onCreate() y en BootReceiver.
         */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            
            val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(
                15, TimeUnit.MINUTES
            )
                .setConstraints(constraints)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    5, TimeUnit.MINUTES
                )
                .build()
            
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                syncRequest
            )
            
            Log.i(TAG, "Periodic sync scheduled every 15 minutes")
        }
        
        /**
         * Cancela el sync periódico.
         */
        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
            Log.i(TAG, "Periodic sync cancelled")
        }
    }
    
    override suspend fun doWork(): Result {
        return withContext(Dispatchers.IO) {
            try {
                val db = AquatechDatabase.getInstance(applicationContext)
                val pendingCount = db.syncDao().getPendingCount()
                
                Log.i(TAG, "WorkManager check: $pendingCount pending items")
                
                if (pendingCount > 0) {
                    // Hay items pendientes — arrancar el Foreground Service
                    val intent = Intent(applicationContext, SyncForegroundService::class.java)
                    ContextCompat.startForegroundService(applicationContext, intent)
                    Log.i(TAG, "Started SyncForegroundService for $pendingCount items")
                }
                
                // Limpiar items completados de hace más de 7 días
                val sevenDaysAgo = System.currentTimeMillis() - (7 * 24 * 60 * 60 * 1000L)
                db.syncDao().cleanupCompleted(sevenDaysAgo)
                
                Result.success()
            } catch (e: Exception) {
                Log.e(TAG, "WorkManager sync check failed", e)
                Result.retry()
            }
        }
    }
}
