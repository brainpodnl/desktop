use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::Result;

/// The Settings window's label. Everything that must not treat it like the pod
/// window — the tunnel teardown, the vibrancy material, the capability file —
/// keys off this.
pub const SETTINGS_LABEL: &str = "settings";

pub const MAIN_LABEL: &str = "main";

const MENU_ITEM_ID: &str = "settings";

/// Wide enough that a setting's name, the sentence that explains it and the
/// control that changes it read as one line rather than three stacked
/// fragments. The height is a starting value only: the webview measures the
/// column and sizes the window to it.
const WIDTH: f64 = 660.0;
const INITIAL_HEIGHT: f64 = 480.0;

/// Installs the standard macOS Settings item into the app menu Tauri already
/// builds. Rebuilding that menu by hand is how an app loses Services, Hide
/// Others, and the Edit submenu that gives the webview its Cut/Copy/Paste key
/// equivalents.
///
/// Windows and Linux deliberately keep no native menu bar. Their `Ctrl+,`
/// shortcut is handled by the document; creating `Menu::default` there adds a
/// separate bar above the webview, which also inherits native theme colours
/// independently from the document.
pub fn install_menu(app: &AppHandle) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }

    let menu = Menu::default(app)?;
    let item = MenuItem::with_id(app, MENU_ITEM_ID, "Settings…", true, Some("Cmd+,"))?;
    let separator = PredefinedMenuItem::separator(app)?;

    let items = menu.items()?;
    let first = items.first().and_then(|item| item.as_submenu());

    if let Some(submenu) = first {
        submenu.insert(&separator, 2)?;
        submenu.insert(&item, 2)?;
    }

    app.set_menu(menu)?;
    Ok(())
}

/// Routes the one menu item this app owns. Every other id belongs to a
/// predefined item, which AppKit has already handled by the time this runs.
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() != MENU_ITEM_ID {
        return;
    }

    if let Err(error) = open(app) {
        eprintln!("could not open the settings window: {error}");
    }
}

/// Opens Settings, or brings it forward if it is already open. Never two.
pub fn open(app: &AppHandle) -> Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        return Ok(window);
    }

    /*
     * Same document, different label: `main.tsx` reads the label and mounts the
     * Settings root instead of the app. One bundle, one stylesheet, and no
     * second Vite entry to keep in step with the first.
     *
     * Not transparent, and no vibrancy: the sidebar's material is the pod
     * window's own signature, and a second blurred surface floating over it
     * would read as a third kind of ground. A Settings window is opaque paper.
     */
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::default())
        .title("Settings")
        .inner_size(WIDTH, INITIAL_HEIGHT)
        // A preferences window is exactly as big as what it holds. The webview
        // measures each pane and sets the height, so the user must not be able
        // to fight it for one.
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center();

    // The same chrome as the pod window: the traffic lights float over the
    // content and the title is drawn in the document, so the two windows share
    // one titlebar rather than looking like two apps. This pair MUST stay equal
    // to `trafficLightPosition` in `tauri.conf.json`, which is where the pod
    // window states it and which JSON gives no room to explain; the two drifted
    // apart once already (19 vs 14) and put the lights five points above their
    // own window's title.
    //
    // Neither number is an inset. tao resizes the titlebar container to
    // `button height + y` and leaves the buttons where AppKit put them inside
    // it, so measured against a 14pt button: the close button's left edge lands
    // on `x`, the group ends at `x + 60`, and the row's centre lands on
    // `y - 2`. The document's drag region is 38pt tall and the sidebar's column
    // starts at 16pt, so `x: 16` puts the lights on that column — the Brainpod
    // mark sits directly under them — and `y: 21` centres them in the strip.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 21.0));
    }

    Ok(builder.build()?)
}
