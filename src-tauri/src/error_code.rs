//! Machine-readable error codes for cross-cutting path policy (Phase 5).
//!
//! Path-policy failures used to reach the renderer as ad-hoc strings, so UI code could only
//! match on message text. [`CodedError`] pairs a stable snake_case [`ErrorCode`] with the human
//! message; Tauri serializes it as `{ "code": "...", "message": "..." }`. Kept deliberately
//! small so later IPC-wide error-code work can extend rather than replace it.
//!
//! Two lossless-looking bridges hold the migration boundary together:
//! * `From<String>` - ordinary (non-policy) errors inside a coded surface become `internal`.
//! * `From<CodedError> for String` - command surfaces still carrying plain-string errors
//!   flatten a coded error to its message, keeping today's frontend-visible text identical
//!   until those surfaces migrate.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable machine codes. Serialized as snake_case strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The target project path is not inside an approved root (or approved home mode).
    RootNotApproved,
    /// A relative path escapes the workspace (traversal, absolute path, symlink out).
    PathOutsideRoot,
    /// The target is protected from generic writers (e.g. `.git/**`).
    ProtectedPath,
    /// The destructive operation targets the workspace root itself.
    DestructiveTarget,
    /// The path itself is unusable (unresolvable, vanished, not a directory).
    InvalidPath,
    /// A PTY session id is not (or no longer) registered. The renderer retries transient
    /// races against a still-spawning session on this code instead of matching message text.
    PtyNotFound,
    /// The target name is already taken and the operation refuses to clobber without an
    /// explicit confirmation flag (memory snapshots, duplicate PTY ids).
    AlreadyExists,
    /// Any failure that is not a policy decision (io, parsing, spawn failures).
    Internal,
}

/// A serializable error carrying a stable machine code plus a human-readable message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodedError {
    pub code: ErrorCode,
    pub message: String,
}

impl CodedError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CodedError { code, message: message.into() }
    }

    pub fn root_not_approved(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::RootNotApproved, message)
    }

    pub fn path_outside_root(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PathOutsideRoot, message)
    }

    pub fn protected_path(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ProtectedPath, message)
    }

    pub fn destructive_target(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::DestructiveTarget, message)
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidPath, message)
    }

    pub fn pty_not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PtyNotFound, message)
    }

    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AlreadyExists, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl fmt::Display for CodedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodedError {}

impl From<String> for CodedError {
    fn from(message: String) -> Self {
        CodedError::internal(message)
    }
}

impl From<&str> for CodedError {
    fn from(message: &str) -> Self {
        CodedError::internal(message.to_string())
    }
}

/// Flatten to the human message for command surfaces still returning plain strings. This keeps
/// their frontend-visible error text byte-identical to pre-codes behavior.
impl From<CodedError> for String {
    fn from(err: CodedError) -> Self {
        err.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_stable_snake_case_codes() {
        let cases = [
            (ErrorCode::RootNotApproved, "root_not_approved"),
            (ErrorCode::PathOutsideRoot, "path_outside_root"),
            (ErrorCode::ProtectedPath, "protected_path"),
            (ErrorCode::DestructiveTarget, "destructive_target"),
            (ErrorCode::InvalidPath, "invalid_path"),
            (ErrorCode::PtyNotFound, "pty_not_found"),
            (ErrorCode::AlreadyExists, "already_exists"),
            (ErrorCode::Internal, "internal"),
        ];
        for (code, wire) in cases {
            let json = serde_json::to_string(&CodedError::new(code, "boom")).unwrap();
            assert_eq!(
                json,
                format!("{{\"code\":\"{}\",\"message\":\"boom\"}}", wire),
                "wire shape for {:?}", code
            );
            let back: CodedError = serde_json::from_str(&json).unwrap();
            assert_eq!(back.code, code);
            assert_eq!(back.message, "boom");
        }
    }

    #[test]
    fn display_and_error_impl_expose_the_message() {
        let err = CodedError::protected_path("no .git writes");
        assert_eq!(err.to_string(), "no .git writes");
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn string_errors_classify_as_internal() {
        let from_string: CodedError = "io went sideways".to_string().into();
        assert_eq!(from_string.code, ErrorCode::Internal);
        assert_eq!(from_string.message, "io went sideways");

        let from_str: CodedError = "plain slice".into();
        assert_eq!(from_str.code, ErrorCode::Internal);
    }

    #[test]
    fn lifecycle_helpers_carry_their_codes() {
        assert_eq!(CodedError::pty_not_found("gone").code, ErrorCode::PtyNotFound);
        assert_eq!(CodedError::already_exists("taken").code, ErrorCode::AlreadyExists);
    }

    #[test]
    fn flattening_to_string_keeps_only_the_message() {
        let err = CodedError::destructive_target("refusing to delete the workspace");
        let flattened: String = err.clone().into();
        assert_eq!(flattened, "refusing to delete the workspace");
        // The original stays intact for callers that need the code.
        assert_eq!(err.code, ErrorCode::DestructiveTarget);
    }
}
