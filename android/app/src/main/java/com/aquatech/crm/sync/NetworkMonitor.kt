package com.aquatech.crm.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * NetworkMonitor — Detección real de conexión de red.
 * Más preciso que navigator.onLine de JavaScript.
 * Puede detectar tipo de red (WiFi/Cellular) y velocidad estimada.
 */
class NetworkMonitor(private val context: Context) {
    
    data class NetworkInfo(
        val isConnected: Boolean,
        val type: String,  // WIFI, CELLULAR, NONE, OTHER
        val speedKbps: Int
    )
    
    fun getInfo(): NetworkInfo {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return NetworkInfo(false, "NONE", 0)
        val capabilities = cm.getNetworkCapabilities(network) ?: return NetworkInfo(false, "NONE", 0)
        
        val isConnected = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        val type = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "WIFI"
            else -> "OTHER"
        }
        val speed = capabilities.linkDownstreamBandwidthKbps
        
        return NetworkInfo(isConnected, type, speed)
    }
    
    fun isConnected(): Boolean = getInfo().isConnected
}
