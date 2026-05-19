package com.aquatech.crm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.aquatech.crm.sync.SyncBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(SyncBridgePlugin.class);
    }
}
