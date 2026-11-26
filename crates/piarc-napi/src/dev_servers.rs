//! Exports of launch configurations and development servers (ADR-0092). Results are JSON text.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// The launch configurations of open session `sessionId`'s project, their problems,
    /// whether the project may run them and the servers the session started: JSON
    /// `LaunchView`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn launch_configs<'env>(
        &self,
        env: &'env Env,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.launchConfigs", |core, done| {
            core.launch_configs(session_id, done)
        })
    }

    /// Starts a launch configuration: JSON `{ sessionId, name, agent?: { sessionId,
    /// toolCallId }, wait? }`. Answers its `DevServerState`; with `wait`, once it is ready or
    /// failed. An agent's first start of a configuration in the session asks the user.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn start_dev_server<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.startDevServer", |core, done| {
            core.start_dev_server(request_json, done)
        })
    }

    /// Stops session `sessionId`'s development server `name` with its whole process tree.
    /// Answers its `DevServerState`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn stop_dev_server<'env>(
        &self,
        env: &'env Env,
        session_id: String,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.stopDevServer", |core, done| {
            core.stop_dev_server(session_id, name, done)
        })
    }
}
