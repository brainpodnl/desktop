use tauri::Manager;

mod auth;
mod cli;
mod client;
mod commands;
mod config;
mod error;
mod settings;
mod skills;
mod tunnel;

pub mod proto {
    pub mod tunnel {
        pub mod v1 {
            tonic::include_proto!("brainpod.tunnel.v1");
        }
    }
}

/// rustls 0.23 refuses to build a TLS config until a process-wide provider is
/// set, and both reqwest and tonic reach it lazily on their first connection.
/// Installing here turns a would-be runtime failure into a startup no-op.
fn install_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// macOS blurs the desktop through the window itself, so the frontend leaves the
/// sidebar bare to expose it and paints the content pane opaque on top. That is
/// the Finder composition, and `UnderWindowBackground` is the material for it.
/// The effect is cosmetic, so losing it must never cost us a launch.
#[cfg(target_os = "macos")]
fn apply_window_vibrancy(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("skipping window vibrancy: no webview window labelled \"main\"");
        return;
    };

    if let Err(error) = window_vibrancy::apply_vibrancy(
        &window,
        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
        None,
        None,
    ) {
        eprintln!("window vibrancy unavailable, keeping the plain window background: {error}");
    }
}

pub fn run() {
    install_crypto_provider();

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // `tauri dev` runs an unbundled binary that the updater could never replace,
    // so registering it there only buys a confusing failure on every launch.
    // Shipped builds are the only ones that can act on an update.
    #[cfg(not(debug_assertions))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            apply_window_vibrancy(app);
            settings::install_menu(app.handle())?;
            Ok(())
        })
        .on_menu_event(settings::on_menu_event)
        .manage(auth::Auth::new())
        .manage(tunnel::Tunnels::new())
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::auth_begin,
            commands::auth_cancel,
            commands::auth_sign_out,
            commands::api_pods,
            commands::api_revisions,
            commands::api_resources,
            commands::api_events,
            commands::api_deploy,
            commands::api_redeploy,
            commands::api_set_replicas,
            commands::api_set_instance,
            commands::api_revision_diff,
            commands::open_external,
            commands::port_available,
            commands::port_random,
            commands::tunnel_start,
            commands::tunnel_stop,
            commands::tunnel_list,
            commands::skills_scan,
            commands::skills_latest,
            commands::skills_install,
            commands::skills_remove,
            commands::skills_reveal,
            commands::cli_status,
            commands::cli_latest,
            commands::cli_install,
            commands::cli_remove,
            commands::cli_reveal,
            commands::open_settings,
            commands::set_window_theme,
            commands::set_default_pod,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Tunnels hold a live gRPC session in the control plane. Closing
                // the window without CloseSession would leave it open until its
                // deadline — but closing *Settings* must cost the user nothing,
                // so only the pod window's own teardown counts.
                if window.label() != settings::MAIN_LABEL {
                    return;
                }

                window.state::<tunnel::Tunnels>().shutdown_blocking();

                // Settings is a utility window: it belongs to the pod window and
                // has no reason to keep the app alive on its own.
                if let Some(panel) = window.get_webview_window(settings::SETTINGS_LABEL) {
                    let _ = panel.close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Brainpod Desktop")
        .run(|app, event| {
            /*
             * The window event alone is not enough: Cmd+Q and the app menu's
             * Quit terminate the process without guaranteeing it. `Exit` is the
             * one hook every route passes through, and `shutdown_blocking`
             * drains the map, so running it twice is a no-op the second time.
             */
            if let tauri::RunEvent::Exit = event {
                app.state::<tunnel::Tunnels>().shutdown_blocking();
            }
        });
}
