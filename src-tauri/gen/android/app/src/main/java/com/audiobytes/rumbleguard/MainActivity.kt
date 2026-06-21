package com.audiobytes.rumbleguard

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        initNdkContext() // must run before any invoke() can reach Rust audio code
    }

    // Implemented in lib.rs as Java_com_audiobytes_rumbleguard_MainActivity_initNdkContext
    private external fun initNdkContext()
}