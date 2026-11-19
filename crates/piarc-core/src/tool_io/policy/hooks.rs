//! The hook slots of the decision ladder (architecture section 6.2.3): step 2 PreToolUse and
//! step 8 PermissionRequest. T25 fills them with command hooks; until then [`NoHooks`] has no
//! opinion. Whatever a slot answers, `piarc_policy::decide` keeps deny and ask rules, critical
//! deletions and plan mode ahead of a hook's allow.
use std::future::Future;
use std::pin::Pin;

use piarc_policy::HookVerdict;
use piarc_protocol::policy::PolicyEvaluateParams;

/// A slot's pending answer.
pub(crate) type HookFuture<'a> = Pin<Box<dyn Future<Output = HookVerdict> + Send + 'a>>;

/// The two hook events a permission decision consults.
pub(crate) trait PolicyHooks: Send + Sync {
    /// Step 2: before the rules.
    fn pre_tool_use<'a>(&'a self, call: &'a PolicyEvaluateParams) -> HookFuture<'a>;
    /// Step 8: before the user is asked.
    fn permission_request<'a>(&'a self, call: &'a PolicyEvaluateParams) -> HookFuture<'a>;
}

/// No hooks configured.
pub(crate) struct NoHooks;

impl PolicyHooks for NoHooks {
    fn pre_tool_use<'a>(&'a self, _: &'a PolicyEvaluateParams) -> HookFuture<'a> {
        Box::pin(async { HookVerdict::None })
    }

    fn permission_request<'a>(&'a self, _: &'a PolicyEvaluateParams) -> HookFuture<'a> {
        Box::pin(async { HookVerdict::None })
    }
}
