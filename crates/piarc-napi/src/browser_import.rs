//! Exports of the Chrome sign-in import (ADR-0090). Results are JSON text. `chromeImport`
//! answers the decrypted cookies: the text is handed to V8 straight from Core's zeroizing
//! buffer, which is cleared once the JavaScript string exists.

use std::path::PathBuf;

use napi::bindgen_prelude::{Object, ToNapiValue};
use napi::{Env, sys};
use napi_derive::napi;
use zeroize::Zeroizing;

use crate::runtime::CoreRuntime;

/// Secret JSON text: converted to a JavaScript string, then cleared.
struct SecretText(Zeroizing<String>);

#[allow(
    unsafe_code,
    reason = "NAPI-RS's conversion trait is unsafe; this forwards to its `&String` conversion"
)]
impl ToNapiValue for SecretText {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        // SAFETY: the same environment NAPI-RS handed this call; the `&String` conversion copies
        // the text into V8 before returning, and `val` (cleared on drop) outlives it.
        unsafe { <&String as ToNapiValue>::to_napi_value(env, &val.0) }
    }
}

type SecretSettle = Box<dyn FnOnce(Env) -> napi::Result<SecretText> + Send>;

#[napi]
impl CoreRuntime {
    /// Chrome's profiles: `{ chrome, profiles: [{ id, name }] }` (`chrome` is false when
    /// Chrome's folder is not there).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn chrome_profiles<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.chromeProfiles", |core, done| {
            core.chrome_profiles(done)
        })
    }

    /// The sites of a Chrome profile with their cookie counts, no value:
    /// `{ sites: [{ site, count }] }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn chrome_sites<'env>(
        &self,
        env: &'env Env,
        profile: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.chromeSites", |core, done| {
            core.chrome_sites(profile, done)
        })
    }

    /// Imports sites the user confirmed: JSON `{ workspace, profile, sites }`. Reads the key
    /// once (the macOS keychain prompt), records the sites and audits them. Answers
    /// `{ cookies: [{ site, url, name, value, domain?, path, secure, httpOnly,
    /// expirationDate?, sameSite }], sites: [{ site, imported, skipped: [{ reason, count }] }] }`;
    /// the values are for the browser partition only.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn chrome_import<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<SecretText, SecretSettle>()?;
        crate::boundary::call(env, "CoreRuntime.chromeImport", || {
            self.core.chrome_import(request_json, move |result| {
                let settle: SecretSettle = Box::new(move |env| match result {
                    Ok(text) => Ok(SecretText(text)),
                    Err(error) => Err(crate::boundary::js_error(&env, &error.to_error_object())),
                });
                deferred.resolve(settle);
            })
        })?;
        Ok(promise)
    }

    /// The sites of a workspace with imported sign-ins:
    /// `{ imports: [{ site, count, profile, importedAt }] }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn browser_imports<'env>(
        &self,
        env: &'env Env,
        workspace: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.browserImports", |core, done| {
            core.browser_imports(PathBuf::from(workspace), done)
        })
    }

    /// Forgets an imported site of a workspace after the main process removed its cookies
    /// from the partition: `{ forgot }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn forget_browser_import<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        site: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.forgetBrowserImport", |core, done| {
            core.forget_browser_import(PathBuf::from(workspace), site, done)
        })
    }
}
