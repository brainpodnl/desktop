use std::fmt;

/// Every command failure reaches the webview as a plain string. The Brainpod API
/// already returns human-readable messages, and `anyhow`'s context chain reads
/// better flattened than as a nested object nothing in the UI would branch on.
#[derive(Debug)]
pub struct Error(String);

impl Error {
    pub fn message(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<anyhow::Error> for Error {
    fn from(error: anyhow::Error) -> Self {
        let mut message = error.to_string();
        for cause in error.chain().skip(1) {
            message.push_str(": ");
            message.push_str(&cause.to_string());
        }
        Self(message)
    }
}

/// Window and menu calls fail with tauri's own error, and every one of them in
/// this app is reported to the user as a sentence like any other failure.
impl From<tauri::Error> for Error {
    fn from(error: tauri::Error) -> Self {
        Self(error.to_string())
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
