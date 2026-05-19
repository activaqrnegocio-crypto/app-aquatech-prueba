package com.aquatech.crm.sync

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * BatteryDefensePlugin — Capacitor plugin for managing battery optimization exemptions.
 * Critical for keeping background services running on aggressive Android flavors (Xiaomi, Huawei, etc.).
 */
@CapacitorPlugin(name = "BatteryDefense")
class BatteryDefensePlugin : Plugin() {

    @PluginMethod
    fun isExempt(call: PluginCall) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val isIgnoring = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                pm.isIgnoringBatteryOptimizations(context.packageName)
            } else {
                true
            }
            val res = JSObject()
            res.put("isExempt", isIgnoring)
            call.resolve(res)
        } catch (e: Exception) {
            call.reject("Error checking exemption: ${e.message}")
        }
    }

    @PluginMethod
    fun requestExemption(call: PluginCall) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${context.packageName}")
                    }
                    // Start activity
                    context.startActivity(intent)
                }
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("Error requesting exemption: ${e.message}")
        }
    }

    @PluginMethod
    fun getInstructions(call: PluginCall) {
        val manufacturer = Build.MANUFACTURER.lowercase()
        val instructions = when (manufacturer) {
            "xiaomi" -> "Ajustes → Batería → Aquatech CRM → Sin restricciones. Además, active el 'Inicio automático' si está disponible."
            "huawei" -> "Ajustes → Batería → Inicio de aplicaciones → Aquatech CRM → Gestionar manualmente → Permitir inicio automático, secundario y actividad en segundo plano."
            "samsung" -> "Ajustes → Cuidado del dispositivo → Batería → Límites de uso en segundo plano → Aplicaciones nunca inactivas → Añadir Aquatech CRM."
            "oppo", "realme" -> "Ajustes → Batería → Ahorro de energía → Aquatech CRM → Permitir actividad en segundo plano y autoinicio."
            else -> "Ajustes → Batería → Optimización de batería → Seleccione 'Todas las aplicaciones' → Aquatech CRM → 'No optimizar'."
        }
        val res = JSObject()
        res.put("instructions", instructions)
        call.resolve(res)
    }
}
