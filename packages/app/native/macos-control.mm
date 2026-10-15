#include <node_api.h>
#include <string>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

static napi_value Bool(napi_env env, bool value) {
	napi_value result;
	napi_get_boolean(env, value, &result);
	return result;
}

static napi_value String(napi_env env, NSString *value) {
	napi_value result;
	const char *utf8 = value ? value.UTF8String : "";
	napi_create_string_utf8(env, utf8, NAPI_AUTO_LENGTH, &result);
	return result;
}

static NSString *ArgumentString(napi_env env, napi_value value) {
	size_t length = 0;
	if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return nil;
	std::string buffer(length + 1, '\0');
	if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return nil;
	return [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
}

static napi_value PreflightPostEvent(napi_env env, napi_callback_info info) {
	return Bool(env, CGPreflightPostEventAccess());
}

static napi_value RequestPostEvent(napi_env env, napi_callback_info info) {
	return Bool(env, CGRequestPostEventAccess());
}

static napi_value FrontmostBundleId(napi_env env, napi_callback_info info) {
	@autoreleasepool {
		return String(env, NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier ?: @"");
	}
}

static napi_value ActivateCodexThread(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	if (argc != 1) {
		napi_throw_type_error(env, nullptr, "A Codex thread URL is required");
		return nullptr;
	}
	@autoreleasepool {
		NSString *thread = ArgumentString(env, argv[0]);
		NSURL *threadURL = thread ? [NSURL URLWithString:thread] : nil;
		NSURL *applicationURL = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:@"com.openai.codex"];
		if (!threadURL || !applicationURL) return Bool(env, false);
		NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
		configuration.activates = YES;
		__block BOOL completed = NO;
		__block BOOL succeeded = NO;
		[NSWorkspace.sharedWorkspace openURLs:@[threadURL] withApplicationAtURL:applicationURL configuration:configuration completionHandler:^(NSRunningApplication *running, NSError *error) {
			succeeded = running != nil && error == nil && [running activateWithOptions:NSApplicationActivateIgnoringOtherApps];
			completed = YES;
		}];
		NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
		while (!completed && [deadline timeIntervalSinceNow] > 0) {
			[NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
		}
		return Bool(env, completed && succeeded);
	}
}

static napi_value PostDecision(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
	if (argc != 1) {
		napi_throw_type_error(env, nullptr, "A fixed decision is required");
		return nullptr;
	}
	@autoreleasepool {
		NSString *decision = ArgumentString(env, argv[0]);
		CGKeyCode keyCode;
		if ([decision isEqualToString:@"approve"]) keyCode = 36;
		else if ([decision isEqualToString:@"reject"]) keyCode = 53;
		else {
			napi_throw_range_error(env, nullptr, "Decision must be approve or reject");
			return nullptr;
		}
		if (!CGPreflightPostEventAccess()) return Bool(env, false);
		CGEventRef down = CGEventCreateKeyboardEvent(nullptr, keyCode, true);
		CGEventRef up = CGEventCreateKeyboardEvent(nullptr, keyCode, false);
		if (!down || !up) {
			if (down) CFRelease(down);
			if (up) CFRelease(up);
			return Bool(env, false);
		}
		CGEventPost(kCGSessionEventTap, down);
		CGEventPost(kCGSessionEventTap, up);
		CFRelease(down);
		CFRelease(up);
		return Bool(env, true);
	}
}

static napi_value Init(napi_env env, napi_value exports) {
	napi_property_descriptor properties[] = {
		{ "preflightPostEventAccess", nullptr, PreflightPostEvent, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "requestPostEventAccess", nullptr, RequestPostEvent, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "frontmostBundleId", nullptr, FrontmostBundleId, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "activateCodexThread", nullptr, ActivateCodexThread, nullptr, nullptr, nullptr, napi_default, nullptr },
		{ "postDecision", nullptr, PostDecision, nullptr, nullptr, nullptr, napi_default, nullptr },
	};
	napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
	return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
