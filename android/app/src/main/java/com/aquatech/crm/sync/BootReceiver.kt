package com.aquatech.crm.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BootReceiver — Se ejecuta cuando el teléfono termina de reiniciarse.
 * Reprograma el WorkManager para que el sync periódico siga funcionando.
 */
class BootReceiver : BroadcastReceiver() {
    
    companion object {
        private const val TAG = "BootReceiver"
    }
    
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i(TAG, "Device rebooted — rescheduling sync")
            SyncWorker.schedule(context)
        }
    }
}
