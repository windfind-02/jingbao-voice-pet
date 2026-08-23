window.__ModuleLoader__.load({
	id: "@local/dsh-pet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ═══════════════════════════════════════════════════════════════════
		//  常量
		// ═══════════════════════════════════════════════════════════════════
		// 全局单例（模块级）：防止 DSH 重载插件时 apply 重复执行，
		// 产生「双 MutationObserver + 双语音池」→ 确认弹窗触发两条语音同时播放
		let jbVoiceCache = null;     // 唯一的语音 Audio 池
		let jbConfirmMO = null;      // 唯一的确认弹窗观察器
		let jbAskMO = null;          // 唯一的提问框观察器
		let jbDoneMO = null;         // 唯一的回合页脚（任务完成）观察器
		let jbActiveApplyId = 0;     // 当前生效的 apply 实例代际号（旧实例残留路径禁止播报）
		let jbApplied = false;       // 是否已初始化过
		/** 停掉语音池里所有 Audio（无脑 pause：play() 异步启动瞬间 paused 可能仍为 false，
		 *  靠 !paused 判断会漏停 → 多声音叠加；无脑 pause 已停的 Audio 也无害）。 */
		function jbStopAllVoices() {
			try {
				if (!jbVoiceCache) return;
				Object.keys(jbVoiceCache).forEach((group) => {
					(jbVoiceCache[group] || []).forEach((a) => {
						if (a) {
							try { a.pause(); a.currentTime = 0; } catch (e) { /* ignore */ }
						}
					});
				});
			} catch (e) { /* 忽略 */ }
		}
		/** 把音量条的值实时应用到语音池所有 Audio（正在播的立即变音量）。 */
		function jbApplyVoiceVolume(monitor) {
			try {
				if (!jbVoiceCache) return;
				const vol = monitor && typeof monitor.voiceVolume === "number"
					? Math.max(0, Math.min(1, monitor.voiceVolume / 100))
					: 0.7;
				Object.keys(jbVoiceCache).forEach((group) => {
					(jbVoiceCache[group] || []).forEach((a) => {
						if (a) { try { a.volume = vol; } catch (e) { /* ignore */ } }
					});
				});
			} catch (e) { /* 忽略 */ }
		}
		/** 动作帧（透明底 Q 版鲸宝，放在前端 dist 下）。 */
		const FRAMES = {
			idle: "/pet.png?v=2",        // 待机站姿（H3 动画首帧，与动画角色大小一致）
			wave: "/pet_wave.png",   // 挥手（静态帧，动图缺失时的兜底）
			sleepy: "/pet_sleepy.png", // 打瞌睡（闭眼）
			sleepyF0: "/pet_sleepy_f0.png?v=1" // 瞌睡动图首帧静帧（与 pet_sleepy.webp 首帧像素一致，用于动图切换瞬间无缝垫底）
		};
		/** 动图（透明底 WebP 循环动画，真·动作；缺失时自动退回对应静态帧）。 */
		const ANIMS = {
			wave: "/pet_wave.webp?v=3",   // 挥手循环动图
			sleepy: "/pet_sleepy.webp?v=4", // 歪头瞌睡循环动图（A-B-A 往复，无跳变）
			smile: "/pet_smile.webp?v=3",    // 微笑合十循环动图
			shake: "/pet_shake.webp?v=3",    // 被点击后幸福摇头动图
			blink: "/pet_blink.webp?v=3",    // 眨眼动图（正常状态随机触发）
			yawn: "/pet_yawn.webp?v=3",      // 犯困哈欠动图（进入瞌睡第一段）
			wakeup: "/pet_wakeup.webp?v=3",   // 打断瞌睡动画（瞌睡→醒来→待机）
			grab: "/pet_grab.webp?v=3",        // 被抓住动画（按住时循环播放）
			heart: "/pet_heart.webp?v=1"        // 双手在胸前比心（点击互动之一，首尾帧无缝循环）
		};
		/** 语音（点击/确认时播放，mp3 在 dist；音色为克隆的鲸宝专属声线）。 */
		const VOICES = {
			poke: ["/voice_poke_1.mp3", "/voice_poke_2.mp3", "/voice_poke_3.mp3", "/voice_poke_4.mp3"],
			confirm: ["/voice_confirm_1.mp3", "/voice_confirm_2.mp3", "/voice_confirm_3.mp3", "/voice_confirm_4.mp3"],
			done: ["/voice_done_1.mp3", "/voice_done_2.mp3", "/voice_done_3.mp3"],
			ask: ["/voice_ask_1.mp3", "/voice_ask_2.mp3", "/voice_ask_3.mp3"]
		};
		/** 桌宠显示高度默认值（可缩放范围 128~512）。 */
		const PET_HEIGHT_DEFAULT = 256;
		const PET_HEIGHT_MIN = 128;
		const PET_HEIGHT_MAX = 512;
		/** 当前版本（发布时与 index.js 的 PET_VERSION 同步 + 更新仓库 version 文件）。 */
		const PET_VERSION = "1.7.0";
		/** 长时间无操作进入瞌睡的阈值（3 分钟）。 */
		const SLEEPY_AFTER_MS = 3 * 60 * 1000;
		/** 连续活跃多久开始劝休息（50 分钟）。 */
		const REST_AFTER_MS = 50 * 60 * 1000;
		/** 两次休息/深夜提醒的最小间隔（30 分钟）。 */
		const REST_INTERVAL_MS = 30 * 60 * 1000;
		/** 确认气泡防抖间隔（毫秒）。 */
		const CONFIRM_COOLDOWN = 3500;
		/** 待机随机卖萌的最小 / 最大间隔（毫秒）。 */
		const IDLE_MIN = 30000;
		const IDLE_MAX = 60000;

		// ═══════════════════════════════════════════════════════════════════
		//  文案池
		// ═══════════════════════════════════════════════════════════════════
		const IDLE_LINES = [
			"主人，鲸宝在这里～🐳",
			"有什么需要鲸宝做的吗？",
			"主人辛苦啦，摸摸鲸宝吧～",
			"鲸宝会一直陪着主人的哦！",
			"咕噜咕噜～🐋",
			"今天也要元气满满哦！",
			"主人～戳戳鲸宝嘛～"
		];
		const CONFIRM_LINES = [
			"主人主人，这里需要你确认一下哦～",
			"主人主人～有件事要你拍板啦！",
			"主人主人，看这里，需要你确认～",
			"主人主人~鲸宝在等你的确认呢~"
		];
		const ASK_LINES = [
			"主人主人，有几个方案需要您确认一下哦~",
			"主人主人，有一个问题想听听您的意见呢~",
			"主人主人，有一个关键问题需要您的决策哦~"
		];
		const POKE_LINES = [
			"呀！主人戳到鲸宝啦～💕",
			"嘿嘿，鲸宝好开心～",
			"主人～鲸宝最喜欢你啦！",
			"主人最喜欢鲸宝了对吧？"
		];
		/** 任务完成播报（与 voice_done_1~3.mp3 一一对应）。 */
		const DONE_LINES = [
			"主人，任务完成啦！",
			"主人，任务已经完成了哦~",
			"主人，快来看看任务完成的怎么样吧~"
		];
		const HOVER_LINES = [];
		const INPUT_LINES = [
			"主人，要和鲸宝说什么呀～",
			"鲸宝准备好啦，主人说吧～",
			"主人打字的样子好认真～",
			"嗯嗯，鲸宝在听～"
		];
		const WAKE_LINES = [
			"啊…主人回来啦，鲸宝在呢～",
			"主人，鲸宝才没有偷懒哦！",
			"欢迎回来，主人～"
		];
		const SMILE_LINES = [
			"主人～鲸宝好幸福呀～💕",
			"嘿嘿，想到主人就忍不住开心起来了～",
			"主人真好，鲸宝最喜欢主人啦～"
		];
		const ZZZ_LINES = [
			"呼…zzz…",
			"咕噜…zzz…",
			"呼～呼～zzz…"
		];
		const REST_LINES = [
			"主人，你连续忙了好一会儿啦，起来伸个懒腰、喝口水吧～☕",
			"主人，让眼睛休息一下，看看远处放松放松～",
			"主人辛苦啦，记得起来走动走动，鲸宝心疼你～"
		];
		const NIGHT_LINES = [
			"夜深了，主人该休息啦，别熬夜哦～💤",
			"主人，熬夜伤身体，鲸宝会心疼的～",
			"很晚啦主人，早点休息，鲸宝给你说晚安～🌙"
		];

		// ═══════════════════════════════════════════════════════════════════
		//  CSS
		// ═══════════════════════════════════════════════════════════════════
		const PET_CSS = `
/* ── 鲸宝桌宠 @local/dsh-pet 生成的样式 ── */
#jingbao-pet.jb-pet {
	position: fixed;
	right: 22px;
	bottom: 22px;
	z-index: 9999;
	width: var(--pet-w, 172px);
	height: var(--pet-h, 256px);
	pointer-events: none;
	user-select: none;
	-webkit-user-select: none;
}
#jingbao-pet .jb-body {
	pointer-events: auto;
	cursor: pointer;
	display: flex;
	align-items: flex-end;
	justify-content: center;
	width: 100%;
	height: 100%;
	background: none;
	border: none;
	padding: 0;
	margin: 0;
	animation: jb-breathe 2.6s ease-in-out infinite;
	-webkit-tap-highlight-color: transparent;
	outline: none;
}
#jingbao-pet .jb-img {
	display: block;
	height: var(--pet-h, 256px);
	width: auto;
	animation: jb-sway 5.2s ease-in-out infinite;
	filter: drop-shadow(0 6px 12px rgba(60, 100, 180, 0.28));
	-webkit-user-drag: none;
}
#jingbao-pet .jb-anim {
	display: none;
}
#jingbao-pet .jb-emoji {
	display: block;
	font-size: calc(var(--pet-h, 256px) - 12px);
	line-height: 1;
	text-align: center;
	animation: jb-sway 5.2s ease-in-out infinite;
	filter: drop-shadow(0 6px 12px rgba(60, 100, 180, 0.28));
}
/* 点击弹跳 */
#jingbao-pet .jb-body.jb-hop {
	animation: jb-hop 0.62s cubic-bezier(.34, 1.56, .64, 1) both;
}
/* 气泡框 */
#jingbao-pet .jb-bubble {
	position: absolute;
	bottom: calc(100% + 16px);
	left: 50%;
	max-width: calc(var(--pet-h, 256px) * 2.0);
	padding: calc(var(--pet-h, 256px) * 0.04) calc(var(--pet-h, 256px) * 0.06);
	background: #ffffff;
	color: #35506e;
	font-size: calc(var(--pet-h, 256px) * 0.05);
	line-height: 1.45;
	font-weight: 500;
	border-radius: calc(var(--pet-h, 256px) * 0.055);
	border: 1px solid rgba(120, 160, 220, 0.25);
	box-shadow: 0 8px 22px rgba(60, 100, 180, 0.18);
	opacity: 0;
	transform: translateX(-50%) translateY(8px) scale(0.92);
	transform-origin: bottom center;
	transition: opacity .22s ease, transform .22s ease;
	pointer-events: none;
	white-space: normal;
	z-index: 3;
}
#jingbao-pet .jb-bubble.show {
	opacity: 1;
	transform: translateX(-50%) translateY(0) scale(1);
}
/* 确认气泡按钮 */
#jingbao-pet .jb-bubble-actions {
	display: none;
	gap: 8px;
	margin-top: 8px;
}
#jingbao-pet .jb-bubble-actions.show { display: flex; }
#jingbao-pet .jb-bubble-btn {
	flex: 1;
	padding: 6px 10px;
	border: none;
	border-radius: 8px;
	font-size: 13px;
	cursor: pointer;
	white-space: nowrap;
	pointer-events: auto;
}
#jingbao-pet .jb-bubble-btn-yes { background: #6fa8f0; color: #fff; }
#jingbao-pet .jb-bubble-btn-yes:hover { background: #8fc0f5; }
#jingbao-pet .jb-bubble-btn-no { background: #e3eefb; color: #35506e; }
#jingbao-pet .jb-bubble-btn-no:hover { background: #d4e6fa; }
@keyframes jb-breathe {
	0%, 100% { transform: translateY(0); }
	50% { transform: translateY(-7px); }
}
@keyframes jb-sway {
	0%, 100% { transform: rotate(0deg); }
	25% { transform: rotate(1.6deg); }
	75% { transform: rotate(-1.6deg); }
}
@keyframes jb-hop {
	0% { transform: translateY(0) scale(1, 1); }
	28% { transform: translateY(-20px) scale(0.98, 1.04); }
	50% { transform: translateY(0) scale(1.03, 0.96); }
	72% { transform: translateY(-11px) scale(0.99, 1.02); }
	100% { transform: translateY(0) scale(1, 1); }
}
/* 点击爱心飞走特效 */
.jb-heart {
	position: fixed;
	z-index: 10000;
	pointer-events: none;
	animation: jb-heart-fly 1.3s ease-out forwards;
	line-height: 1;
	will-change: transform, opacity;
}
@keyframes jb-heart-fly {
	0% { opacity: 1; transform: translate(0, 0) scale(0.6) rotate(-8deg); }
	100% { opacity: 0; transform: translate(var(--dx, 0px), -90px) scale(1.35) rotate(10deg); }
}
/* 💤 睡眠特效（瞌睡阶段头顶循环漂浮） */
.jb-sleepfx {
	position: absolute;
	top: -26px;
	left: 50%;
	transform: translateX(-50%);
	font-size: 26px;
	display: none;
	pointer-events: none;
	z-index: 1;
	animation: jb-zzz 2.2s ease-in-out infinite;
	line-height: 1;
}
@keyframes jb-zzz {
	0% { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.7); }
	30% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
	100% { opacity: 0; transform: translateX(-50%) translateY(-24px) scale(1.3); }
}
/* 右键菜单 */
.jb-menu {
	position: fixed;
	z-index: 10001;
	display: none;
	min-width: 158px;
	background: #ffffff;
	border: 1px solid rgba(120, 160, 220, 0.3);
	border-radius: 12px;
	box-shadow: 0 10px 28px rgba(60, 100, 180, 0.22);
	padding: 6px;
	font-size: 13px;
	color: #35506e;
	user-select: none;
	pointer-events: auto;
}
.jb-menu-title {
	padding: 6px 10px;
	font-weight: 600;
	border-bottom: 1px solid rgba(120, 160, 220, 0.18);
	margin-bottom: 4px;
}
.jb-menu-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 7px 10px;
	border-radius: 8px;
	cursor: pointer;
}
.jb-menu-item:hover {
	background: rgba(111, 168, 240, 0.16);
	box-shadow: inset 0 0 0 1.5px rgba(111, 168, 240, 0.65);
}
.jb-menu-item input { accent-color: #6fa8f0; cursor: pointer; }
/* 播报音量条（人性化设计：小喇叭静音开关 + 可调音量条，默认 70 留出上调空间） */
.jb-menu-vol {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 2px 8px 8px;
}
.jb-menu-mute {
	background: none;
	border: none;
	font-size: 14px;
	line-height: 1;
	padding: 3px 5px;
	cursor: pointer;
	border-radius: 6px;
	transition: background 0.15s;
}
.jb-menu-mute:hover { background: rgba(111, 168, 240, 0.16); }
.jb-menu-range {
	flex: 1;
	min-width: 0;
	accent-color: #6fa8f0;
	cursor: pointer;
	height: 18px;
}
/* 主菜单 + 子菜单（右键菜单瘦身：一级只放主项，细分项收进子菜单，靠屏幕下方也显示得全） */
.jb-menu-parent {
	position: relative;
	display: flex;
	align-items: center;
}
.jb-menu-parent .jb-menu-master {
	flex: 1;
	min-width: 0;
}
.jb-menu-master-plain { cursor: default; }
.jb-menu-master-plain:hover { background: transparent; box-shadow: none; }
.jb-menu-arrow {
	background: none;
	border: none;
	color: #6fa8f0;
	font-size: 10px;
	padding: 6px 8px;
	cursor: pointer;
	border-radius: 6px;
	line-height: 1;
	transition: transform 0.15s;
}
.jb-menu-arrow:hover { background: rgba(111, 168, 240, 0.16); }
.jb-menu-parent:hover > .jb-menu-arrow { transform: rotate(90deg); }
.jb-menu-sub {
	display: none;
	position: absolute;
	left: 100%;
	top: -4px;
	min-width: 168px;
	background: #ffffff;
	border: 1px solid rgba(120, 160, 220, 0.3);
	border-radius: 10px;
	box-shadow: 0 10px 28px rgba(60, 100, 180, 0.22);
	padding: 6px;
	z-index: 10002;
}
.jb-menu-sub.flip { left: auto; right: 100%; }  /* 靠近屏幕右边缘时向左弹 */
/* 子菜单：鼠标悬停主项自动展开（主流软件标准交互） */
.jb-menu-parent:hover > .jb-menu-sub { display: block; }
/* 操控手册面板 */
.jb-help-panel {
	display: none;
	position: fixed;
	z-index: 10003;
	width: 300px;
	background: #ffffff;
	border: 1px solid rgba(120, 160, 220, 0.3);
	border-radius: 14px;
	box-shadow: 0 14px 34px rgba(60, 100, 180, 0.26);
	padding: 14px 16px;
	font-size: 13px;
	color: #35506e;
	user-select: none;
}
.jb-help-title {
	font-weight: 700;
	font-size: 15px;
	padding-bottom: 8px;
	margin-bottom: 8px;
	border-bottom: 1px solid rgba(120, 160, 220, 0.18);
}
.jb-help-body p { margin: 6px 0; line-height: 1.55; }
.jb-help-body b { color: #4a7fc8; }
.jb-help-tip { color: #8a9bb8; font-size: 12px; }
.jb-help-close {
	margin-top: 10px;
	width: 100%;
	padding: 8px 0;
	border: none;
	border-radius: 8px;
	background: linear-gradient(135deg, #6fa8f0, #8fb6f5);
	color: #ffffff;
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
}
.jb-help-close:hover { filter: brightness(1.06); }
/* 系统监控面板（桌宠下方，鲸宝主题渐变描边 + 纯白内部 + 随缩放） */
.jb-monitor {
	position: absolute;
	top: calc(100% + 10px);
	left: 50%;
	transform: translateX(-50%);
	display: none;
	background: #ffffff;
	border: 4px solid transparent;
	background-image: linear-gradient(#ffffff, #ffffff), linear-gradient(135deg, #6fa8f0 0%, #8fb6f5 25%, #a58ff0 50%, #6fa8f0 75%, #8fc0f5 100%);
	background-origin: border-box;
	background-clip: padding-box, border-box;
	border-radius: 12px;
	padding: calc(var(--pet-h, 256px) * 0.022) calc(var(--pet-h, 256px) * 0.045);
	font-size: calc(var(--pet-h, 256px) * 0.052);
	font-weight: 700;
	box-shadow: 0 6px 18px rgba(60, 100, 180, 0.15);
	white-space: nowrap;
	pointer-events: none;
	z-index: 2;
}
/* 文字：蓝色渐变（蓝→紫→蓝）+ 加粗，35% 透明度白阴影更二次元 */
.jb-monitor-text {
	background-image: linear-gradient(135deg, #3d7bd8 0%, #6a5ad0 45%, #3d7bd8 90%);
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
	text-shadow: 0 1px 3px rgba(255, 255, 255, 0.35);
}
/* 余额并入性能监测第二行（无单独图标，直接写「当前余额」，幼圆可爱字体，字号与第一行一致） */
.jb-monitor-bal {
	margin-top: calc(var(--pet-h, 256px) * 0.02);
	text-align: center;
	font-weight: 600;
	color: #35506e;
	white-space: nowrap;
	font-family: "幼圆", "YouYuan", "Microsoft YaHei", sans-serif;
}
.jb-monitor-amount { color: #2f5fa8; font-weight: 700; }
/* 菜单里余额区块 */
.jb-menu-balance-interval { display: flex; align-items: center; gap: 6px; padding: 2px 10px; font-size: 12px; color: #35506e; }
.jb-menu-balance-interval input[type=range] { flex: 1; accent-color: #6fa8f0; }
.jb-interval-val { min-width: 32px; text-align: right; color: #4a7fc8; font-weight: 600; }
/* 余额数值显示框 + 手动刷新按钮 */
.jb-amount-box {
	margin: 2px 10px 4px;
	padding: 7px 10px;
	border-radius: 8px;
	background: rgba(111, 168, 240, 0.1);
	border: 1px solid rgba(120, 160, 220, 0.28);
	text-align: center;
	font-size: 15px;
	font-weight: 700;
	color: #2f5fa8;
	letter-spacing: 0.5px;
	font-family: "幼圆", "YouYuan", "Microsoft YaHei", sans-serif;
}
.jb-amount-box.jb-amount-error { color: #c0392b; font-size: 13px; font-weight: 600; }
.jb-balance-refresh {
	display: block;
	width: calc(100% - 20px);
	margin: 0 10px 6px;
	padding: 7px 0;
	border: none;
	border-radius: 8px;
	background: linear-gradient(135deg, #6fa8f0, #8fb6f5);
	color: #ffffff;
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
}
.jb-balance-refresh:hover { filter: brightness(1.06); }
`;

		// ═══════════════════════════════════════════════════════════════════
		//  工具
		// ═══════════════════════════════════════════════════════════════════
		function pick(arr) {
			return arr[Math.floor(Math.random() * arr.length)];
		}
		/** 根据时刻返回「报时 + 时段贴心问候」。 */
		/** 整点报时：每小时一句话（参考国内作息，主人钦定）。 */
		function timeGreeting(d) {
			const h = d.getHours();
			const hm = `${h} 点`;
			const LINES = [
				"主人，已经 0 点啦，都过午夜了，快放下手机睡觉吧～💤",
				"主人，1 点啦……这么晚还不睡，鲸宝要担心了～🥺",
				"主人，2 点了……熬夜对身体不好，鲸宝陪你一起睡好不好～",
				"主人，3 点了，再不睡的话明天会没精神的～",
				"主人，4 点了……鲸宝都困得打哈欠了，主人也快休息吧～",
				"主人，5 点了，天快亮了，熬夜的主人快去补个觉～",
				"主人早安～6 点啦，新的一天开始了，元气满满哦！🌞",
				"主人，7 点啦，起床洗漱，美好的一天开始咯～☀️",
				"主人，8 点了，出门前记得吃早餐哦～🥪",
				"主人，9 点啦，工作/学习开始，鲸宝给你加油打气！💪",
				"主人，10 点啦，忙了一会儿了，起来喝口水活动一下吧～",
				"主人，11 点啦，再坚持一下就到饭点咯～",
				"主人，12 点啦，午饭时间到，记得好好吃饭哦～🍚",
				"主人，13 点了，午休时间，小憩一会儿养足精神吧～😴",
				"主人，14 点啦，下午的活儿开始咯，鲸宝陪着你～",
				"主人，15 点了，下午茶时间，给自己泡杯茶休息下吧～☕",
				"主人，16 点啦，工作辛苦了，起来伸个懒腰～",
				"主人，17 点了，快到下班时间啦，再坚持一下～",
				"主人，18 点啦，一天辛苦啦，晚饭想好吃什么了吗？🌙",
				"主人，19 点了，晚上好呀～好好放松一下～",
				"主人，20 点啦，晚饭吃过了吗？记得别饿着肚子～",
				"主人，21 点了，晚上放松时间，看看喜欢的剧或书吧～",
				"主人，22 点啦，该准备休息了哦，鲸宝希望你早点睡～🌙",
				"主人，23 点了，夜深了，快洗漱准备睡觉吧～💤"
			];
			return LINES[h] || `主人，已经 ${hm} 啦～`;
		}
		/** 节日/特殊日期祝福文案（无节日返回空串）。 */
		function holidayGreeting() {
			const d = new Date();
			const key = (d.getMonth() + 1) + "-" + d.getDate();
			const map = {
				"1-1": ["新年快乐，主人！🎉 新的一年鲸宝也会一直陪着主人～"],
				"2-14": ["情人节快乐，主人～💕 鲸宝的心永远属于你！"],
				"6-1": ["儿童节快乐主人！🐳 鲸宝陪主人一起可可爱爱～"],
				"8-15": ["中秋节快乐主人～🌕 鲸宝想和主人一起赏月！"],
				"10-1": ["国庆节快乐主人！好好享受快乐的假期吧！"],
				"12-24": ["平安夜快乐主人～🎄 鲸宝祝你平平安安！"],
				"12-25": ["圣诞快乐主人！听说圣诞老人给每个人都送出礼物，是真的吗～"],
				"12-31": ["跨年快乐主人！🎆 鲸宝要和主人一起迎接新年～"]
			};
			const lines = map[key];
			return lines ? pick(lines) : "";
		}

		// ═══════════════════════════════════════════════════════════════════
		//  确认信号识别（用于"需要主人确认时冒泡"）
		// ═══════════════════════════════════════════════════════════════════
		const CONFIRM_RE = /^(确认|确定|同意|允许|批准|好的|好|是|没问题|立即|OK|Yes|Confirm|Sure|Allow|Approve|Accept)$/i;
		function isConfirmButton(el) {
			const tag = el && el.tagName;
			const role = el && el.getAttribute && el.getAttribute("role");
			if (tag !== "BUTTON" && role !== "button") return false;
			const text = (el.textContent || "").trim();
			if (!text || text.length > 8) return false;
			return CONFIRM_RE.test(text);
		}
		function isDialog(el) {
			if (!el || el.nodeType !== 1) return false;
			const tag = el.tagName;
			const role = el.getAttribute && el.getAttribute("role");
			return tag === "DIALOG" || role === "dialog" || role === "alertdialog";
		}
		/** 拒绝/取消类按钮文案。 */
		const CANCEL_RE = /^(取消|拒绝|否|不|不要|退出|跳过|No|Cancel|Decline|Dismiss|Close)$/i;
		/** 宽松匹配：按钮文案包含这些词就视为"同意/继续"类（覆盖「同意并继续」「确认授权」等组合文案）。 */
		const CONFIRM_CONTAINS = /确认|确定|同意|允许|批准|授权|好的|好|是|没问题|OK|Yes|Confirm|Sure|Allow|Approve|Accept|继续|执行|运行|Run|Go/i;
		/** 宽松匹配：按钮文案包含这些词就视为"取消/拒绝"类。 */
		const CANCEL_CONTAINS = /取消|拒绝|否|退出|跳过|关闭|No|Cancel|Decline|Dismiss|Stop|Deny/i;
		/** 在新增节点里定位确认弹窗：返回 { yesBtn, noBtn, text } 或 null。 */
		function findConfirmSignal(node) {
			if (!node || node.nodeType !== 1) return null;
			try {
				let container = null;
				if (isDialog(node)) container = node;
				else if (node.querySelector) {
					container = node.querySelector("dialog, [role='dialog'], [role='alertdialog']");
				}
				const scanRoot = container || node;
				if (!scanRoot || !scanRoot.querySelectorAll) return null;
				const btns = scanRoot.querySelectorAll("button, [role='button']");
				let yesBtn = null, noBtn = null;
				for (let i = 0; i < btns.length; i += 1) {
					const t = (btns[i].textContent || "").trim();
					if (!t || t.length > 8) continue;
					if (!yesBtn && CONFIRM_RE.test(t)) yesBtn = btns[i];
					else if (!noBtn && CANCEL_RE.test(t)) noBtn = btns[i];
				}
				if (!yesBtn && isConfirmButton(node)) yesBtn = node;
				if (!yesBtn && !noBtn) return null;
				// 从确认按钮向上找弹窗容器（dialog 未直接命中时，取最近的"弹窗状"祖先）
				if (!container) {
					let el = yesBtn || noBtn;
					for (let up = 0; up < 6 && el; up += 1) {
						el = el.parentElement;
						if (!el) break;
						const role = el.getAttribute && el.getAttribute("role");
						const btnCount = el.querySelectorAll ? el.querySelectorAll("button, [role='button']").length : 0;
						if (el.tagName === "DIALOG" || role === "dialog" || role === "alertdialog" ||
							(btnCount >= 2 && el.childElementCount > 3)) {
							container = el;
							break;
						}
					}
				}
				// 提取「简要概括」（标题）+ 正文
				let text = "", summary = "";
				if (container) {
					text = (container.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
					const head = container.querySelector("h1, h2, h3, [role='heading'], [class*='title' i], [class*='Title']");
					if (head) summary = (head.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
				}
				return { yesBtn, noBtn, text, summary };
			} catch (e) { /* ignore */ }
			return null;
		}

		// ═══════════════════════════════════════════════════════════════════
		//  插件主体
		// ═══════════════════════════════════════════════════════════════════
		function apply(ctx) {
			// 0. 防重复注入（HMR / 重复加载时先清理旧桌宠，避免出现多只鲸宝）
			const existed = document.getElementById("jingbao-pet");
			if (existed) existed.remove();
			// 0b. 清理旧的全局单例：断开旧 MO（否则新旧两个观察器同时触发 → 两条语音）
			if (jbConfirmMO) {
				try { jbConfirmMO.disconnect(); } catch (e) { /* 忽略 */ }
				jbConfirmMO = null;
			}
			if (jbAskMO) {
				try { jbAskMO.disconnect(); } catch (e) { /* 忽略 */ }
				jbAskMO = null;
			}
			if (jbDoneMO) {
				try { jbDoneMO.disconnect(); } catch (e) { /* 忽略 */ }
				jbDoneMO = null;
			}
			jbStopAllVoices();  // 停掉旧实例可能还在播的语音
			if (jbVoiceCache) jbVoiceCache = null;
			// 实例代际号：旧实例残留路径（document 监听等）即使触发，playVoiceIndex 也会拒绝播放
			const myApplyId = ++jbActiveApplyId;
			jbApplied = true;

			// 1. 注入样式
			const styleEl = document.createElement("style");
			styleEl.setAttribute("data-plugin", "@local/dsh-pet");
			styleEl.textContent = PET_CSS;
			(document.head || document.documentElement).appendChild(styleEl);

			// 2. 注入 DOM
			const root = document.createElement("div");
			root.id = "jingbao-pet";
			root.className = "jb-pet";
			root.innerHTML = [
				'<div class="jb-bubble" aria-hidden="true">',
				'  <span class="jb-bubble-text"></span>',
				'  <div class="jb-bubble-actions">',
				'    <button class="jb-bubble-btn jb-bubble-btn-yes" type="button">同意</button>',
				'    <button class="jb-bubble-btn jb-bubble-btn-no" type="button">拒绝</button>',
				"  </div>",
				"</div>",
				'<div class="jb-sleepfx" aria-hidden="true">💤</div>',
				'<div class="jb-menu" aria-hidden="true">',
				'  <div class="jb-menu-title">🐳 鲸宝设置</div>',
				'  <div class="jb-menu-parent" data-group="monitor">',
				'    <label class="jb-menu-item jb-menu-master"><input type="checkbox" data-k="enabled" /> 性能监测</label>',
				'    <button class="jb-menu-arrow" type="button" aria-label="展开系统监控子菜单">▶</button>',
				'    <div class="jb-menu-sub">',
				'      <label class="jb-menu-item"><input type="checkbox" data-k="cpu" /> CPU 占用率</label>',
				'      <label class="jb-menu-item"><input type="checkbox" data-k="mem" /> 内存占用率</label>',
				'      <label class="jb-menu-item"><input type="checkbox" data-k="gpu" /> 显卡占用率</label>',
				'    </div>',
				'  </div>',
				'  <div class="jb-menu-parent" data-group="voice">',
				'    <label class="jb-menu-item jb-menu-master"><input type="checkbox" data-k="voiceAll" /> 语音播报</label>',
				'    <button class="jb-menu-arrow" type="button" aria-label="展开语音播报子菜单">▶</button>',
				'    <div class="jb-menu-sub">',
				'      <label class="jb-menu-item"><input type="checkbox" data-k="voiceConfirm" /> 需求确认播报</label>',
				'      <label class="jb-menu-item"><input type="checkbox" data-k="voiceAsk" /> 提问回答播报</label>',
				'      <label class="jb-menu-item"><input type="checkbox" data-k="voicePoke" /> 点击互动播报</label>',
				'      <label class="jb-menu-item"><input type="checkbox" data-k="voiceDone" /> 任务完成播报</label>',
				'    </div>',
				'  </div>',
				'  <div class="jb-menu-title">🎧 播报音量</div>',
				'  <div class="jb-menu-vol">',
				'    <button class="jb-menu-mute" type="button" data-k="voiceMute" aria-label="静音开关">🔊</button>',
				'    <input class="jb-menu-range" type="range" min="0" max="100" step="1" data-k="voiceVolume" value="70" aria-label="播报音量" />',
				'  </div>',
				'  <div class="jb-menu-title">💰 余额显示</div>',
				'  <label class="jb-menu-item"><input type="checkbox" data-k="balanceEnabled" /> 显示余额</label>',
				'  <div class="jb-amount-box" data-balance-amount>未查询</div>',
				'  <div class="jb-menu-balance-interval">',
				'    <span>刷新间隔</span>',
				'    <input type="range" min="1" max="60" step="1" data-k="balanceInterval" value="5" />',
				'    <span class="jb-interval-val" data-interval-val>5 分</span>',
				'  </div>',
				'  <button class="jb-balance-refresh" type="button" data-balance-refresh="1">点击此处刷新余额</button>',
				'  <div class="jb-menu-item jb-menu-help" data-help="1">📖 如何与鲸宝相处</div>',
				'  <div class="jb-menu-update-check jb-menu-item" data-update-check="1">🔄 检查更新</div>',
				'  <div class="jb-menu-item jb-menu-update-do" data-update-do="1" style="display:none">⬇️ 立即更新</div>',
				"</div>",
				'<div class="jb-help-panel" aria-hidden="true">',
				'  <div class="jb-help-title">🐳 如何与鲸宝相处</div>',
				'  <div class="jb-help-body">',
				'    <p>● 主人点一下鲸宝，鲸宝会幸福摇头或双手比心，还会说甜甜的话～</p>',
				'    <p>● 按住鲸宝拖一拖，鲸宝会乖乖跟着主人走（位置鲸宝会记住哦）</p>',
				'    <p>● 滚轮转转，鲸宝可以变大变小（128~512，大小也记着呢）</p>',
				'    <p>● 右键点鲸宝，可以打开鲸宝的设置菜单</p>',
				'    <p>● 鲸宝会提醒主人：需求确认、提问回答、任务完成、点击互动，都可以单独开关；音量可以调，小喇叭可以一键静音</p>',
				'    <p>● 3 分钟没理鲸宝，她会打瞌睡💤，主人鼠标一动，鲸宝立刻醒来迎接；鲸宝还会整点报时、劝主人休息、深夜提醒别熬夜——更多小小细节等主人发现哦～</p>',
				'    <p>● 鲸宝可以实时监测 CPU / 内存 / GPU 的占用（1 秒刷新），GPU 数值动一动 = 任务正在跑</p>',
				'    <p class="jb-help-tip">💡 现在还没有键盘快捷键，全靠主人和鲸宝的默契，鲸宝很好相处的～</p>',
				'  </div>',
				'  <button class="jb-help-close" type="button">知道了</button>',
				"</div>",
				'<div class="jb-monitor" aria-hidden="true">',
				'  <div class="jb-monitor-text"></div>',
				'  <div class="jb-monitor-bal" style="display:none">当前余额&nbsp;&nbsp;<b class="jb-monitor-amount">--</b></div>',
				'</div>',
				'<button class="jb-body" type="button" aria-label="鲸宝桌宠">',
				'  <img class="jb-img jb-static" alt="鲸宝" draggable="false" />',
				'  <img class="jb-img jb-anim" alt="" draggable="false" aria-hidden="true" />',
				"</button>"
			].join("");
			document.body.appendChild(root);

			const body = root.querySelector(".jb-body");
			const staticImg = root.querySelector(".jb-static");
			const animImg = root.querySelector(".jb-anim");
			const bubble = root.querySelector(".jb-bubble");
			const bubbleText = root.querySelector(".jb-bubble-text");
			const bubbleActions = root.querySelector(".jb-bubble-actions");
			const bubbleYes = root.querySelector(".jb-bubble-btn-yes");
			const bubbleNo = root.querySelector(".jb-bubble-btn-no");
			const sleepFx = root.querySelector(".jb-sleepfx");
			const menu = root.querySelector(".jb-menu");
			const helpPanel = root.querySelector(".jb-help-panel");
			const monitorPanel = root.querySelector(".jb-monitor");
			const monitorText = root.querySelector(".jb-monitor-text");
			const monitorBal = root.querySelector(".jb-monitor-bal");
			const monitorAmount = root.querySelector(".jb-monitor-amount");

			// 预加载所有静帧 + 动图，避免切换闪白
			Object.keys(FRAMES).forEach((k) => {
				const pre = new Image();
				pre.src = FRAMES[k];
			});
			Object.keys(ANIMS).forEach((k) => {
				const pre = new Image();
				pre.src = ANIMS[k];
			});

			// 预加载全部语音（mp3 已解码缓存），点击/确认时瞬时出声、无加载延迟
			// 用全局唯一池：apply 重复执行也只建一套，stopAllVoices 跨实例互斥
			const voiceCache = {};
			jbVoiceCache = voiceCache;
			Object.keys(VOICES).forEach((group) => {
				voiceCache[group] = VOICES[group].map((src) => {
					try {
						const a = new Audio(src);
						a.preload = "auto";
						return a;
					} catch (e) { return null; }
				});
			});

			// 状态
			let currentFrame = "idle";
			let frameTimer = null;
			let animTimer = null;
			let lastActivity = Date.now();
			let sleepyFlag = false;
			let sleepyPhase = "none";      // none | yawn | sleeping | waking
			let idleTimer = null;          // 随机动画/卖萌计时器句柄
			let idlePaused = false;        // 计时器暂停标志（瞌睡期间）
			let lastReportedHour = -1;
			let lastRestRemindAt = 0;
			let idleBlockedUntil = 0;
			const SESSION_START = Date.now();
			// 缩放状态（128~512，默认 256，持久化到 localStorage 防止页面重载重置）
			let petHeight = PET_HEIGHT_DEFAULT;
			const SIZE_KEY = "dsh.pet.size.v1";
			try {
				const savedSize = parseInt(localStorage.getItem(SIZE_KEY), 10);
				if (savedSize >= PET_HEIGHT_MIN && savedSize <= PET_HEIGHT_MAX) petHeight = savedSize;
			} catch (e) { /* ignore */ }
			function applyPetSize() {
				root.style.setProperty("--pet-h", petHeight + "px");
				root.style.setProperty("--pet-w", Math.max(172, petHeight) + "px");
				try { localStorage.setItem(SIZE_KEY, String(petHeight)); } catch (e) { /* ignore */ }
			}
			applyPetSize();
			// 位置持久化：页面重载/插件重建后恢复拖拽过的位置
			const POS_KEY = "dsh.pet.pos.v1";
			try {
				const savedPos = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
				if (savedPos && typeof savedPos.left === "number" && typeof savedPos.top === "number") {
					root.style.right = "auto";
					root.style.bottom = "auto";
					root.style.left = savedPos.left + "px";
					root.style.top = savedPos.top + "px";
				}
			} catch (e) { /* ignore */ }
			// 瞌睡流程时长（毫秒；素材就绪后按实际帧数校准）
			const YAWN_MS = 7125;          // 哈欠段时长（171 帧 / 24fps ≈ 7.1s）
			const WAKEUP_MS = 5200;        // 打断动画时长（124 帧 / 24fps ≈ 5.2s）

			// 静帧 / 动图两个图层互斥显示（避免动图播放时静帧残留在背后）
			function showStatic() {
				staticImg.style.display = "block";
				animImg.style.display = "none";
			}
			function showAnim() {
				staticImg.style.display = "none";
				animImg.style.display = "block";
			}
			// 3. 帧切换
			function setFrame(name, hold) {
				if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
				if (name !== currentFrame) {
					showStatic();
					staticImg.src = FRAMES[name];
					currentFrame = name;
				}
				if (hold) {
					frameTimer = setTimeout(() => setFrame("idle"), hold);
				}
			}
			// 3b. 动图播放（真·动作循环 WebP；缺失时退回静态帧）
			function playAnim(name, duration) {
				const src = ANIMS[name];
				if (!src) { setFrame(name, duration); return; }
				if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
				if (animTimer) { clearTimeout(animTimer); animTimer = null; }
				showAnim();
				animImg.src = src;
				currentFrame = "anim:" + name;
				animTimer = setTimeout(() => {
					showStatic();
					staticImg.src = FRAMES.idle;
					currentFrame = "idle";
					animTimer = null;
				}, duration);
			}
			// 3c. 循环播放动图（打瞌睡等持续状态），stopAnim 回到待机
			function playAnimLoop(name) {
				const src = ANIMS[name];
				if (!src) { setFrame(name); return; }
				if (animTimer) { clearTimeout(animTimer); animTimer = null; }
				showAnim();
				animImg.src = src;
				currentFrame = "anim:" + name;
			}
			function stopAnim() {
				if (animTimer) { clearTimeout(animTimer); animTimer = null; }
				showStatic();
				staticImg.src = FRAMES.idle;
				currentFrame = "idle";
			}
			// 3d. 播放一次动图后回调（用于哈欠→瞌睡、打断→待机的流程衔接）
			function playAnimThen(name, duration, onDone) {
				const src = ANIMS[name];
				if (!src) { if (onDone) onDone(); return; }
				if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
				if (animTimer) { clearTimeout(animTimer); animTimer = null; }
				showAnim();
				animImg.src = src;
				currentFrame = "anim:" + name;
				animTimer = setTimeout(() => {
					animTimer = null;
					if (onDone) onDone();
				}, duration);
			}
			// 3e. 💤 睡眠特效（瞌睡阶段持续显示，打断时隐藏）
			function showSleepFx() { sleepFx.style.display = "block"; }
			function hideSleepFx() { sleepFx.style.display = "none"; }
			// 3e2. 预解码动图到内存（decode 完成后切换 src 无需现场下载+解码，避免切换瞬间闪帧）
			//      哈欠播放期间预解码瞌睡/唤醒动图，7 秒窗口足够 9.8MB 大动画解码完毕
			function predecode(name) {
				const src = ANIMS[name];
				if (!src) return;
				try {
					const img = new Image();
					img.src = src;
					if (img.decode) img.decode().catch(() => {});
				} catch (e) { /* 忽略 */ }
			}
			// 3e3. 动图无缝切换：当前已垫同姿势静帧（如瞌睡首帧），待目标动图解码就绪后再替换 src，
			//      避免「src 已换但新帧未解码」导致的空白/闪帧。onDone 在动画播完后回调（仅 wakeup 用）。
			function switchToLoop(name, onDone) {
				const src = ANIMS[name];
				if (!src) { if (onDone) onDone(); return; }
				const img = new Image();
				img.src = src;
				const duration = name === "wakeup" ? WAKEUP_MS : 0;
				const done = () => {
					// 状态守卫：解码期间被打断（如又点了唤醒/进入其他动画）就不替换了
					if (name === "sleepy" && sleepyPhase !== "sleeping") return;
					if (name === "wakeup" && sleepyPhase !== "waking") return;
					if (animTimer) { clearTimeout(animTimer); animTimer = null; }
					animImg.src = src;
					currentFrame = "anim:" + name;
					showAnim();
					if (onDone && duration) {
						animTimer = setTimeout(() => {
							animTimer = null;
							onDone();
						}, duration);
					}
				};
				try {
					if (img.decode) img.decode().then(done).catch(done);
					else img.onload = done;
				} catch (e) { done(); }
			}
			// 3f. 随机动画/卖萌计时器的暂停与恢复（需求③）
			function stopIdleTimer() {
				idlePaused = true;
				if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
			}
			function resumeIdleTimer() {
				idlePaused = false;
				if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
				scheduleIdle();
			}
			// 3g. 瞌睡状态机：哈欠 → 1 秒后💤 → 循环歪头瞌睡 → 打断唤醒回待机
			function startSleepy() {
				sleepyFlag = true;
				sleepyPhase = "yawn";
				stopIdleTimer();   // 哈欠播放那一刻停止随机动画计时器
				// 哈欠 7 秒播放期间预解码瞌睡/唤醒动图，切换时无需现场下载+解码（sleepy 380 帧 9.8MB，不预解码必闪帧）
				predecode("sleepy");
				predecode("wakeup");
				showBubble("呼…主人不在，鲸宝打个盹…", 3000);
				playAnimThen("yawn", YAWN_MS, () => {
					// 哈欠期间若已被唤醒（点击），不再进入瞌睡
					if (sleepyPhase !== "yawn") return;
					sleepyPhase = "sleeping";
					// 无缝衔接：先垫瞌睡动图首帧静帧（与动图首帧像素一致，也≈哈欠末帧），
					// 等 9.8MB 大动图解码就绪后再替换成循环动画，全程画面不空白、姿势不跳变
					showStatic();
					staticImg.src = FRAMES.sleepyF0;
					currentFrame = "sleepyF0";
					switchToLoop("sleepy");
					setTimeout(() => {
						if (sleepyPhase === "sleeping") showSleepFx();  // 1 秒后 💤
					}, 1000);
				});
			}
			function wakeUp() {
				if (!sleepyFlag) return;
				sleepyFlag = false;
				sleepyPhase = "waking";
				hideSleepFx();
				// 无缝衔接：先垫瞌睡首帧静帧（当前画面姿势），wakeup 动图解码就绪后无缝替换
				showStatic();
				staticImg.src = FRAMES.sleepyF0;
				currentFrame = "sleepyF0";
				switchToLoop("wakeup", () => {
					sleepyPhase = "none";
					stopAnim();  // 回到正常待机
					setTimeout(() => resumeIdleTimer(), 7000);  // 打断后 7 秒恢复计时器
				});
				showBubble(pick(WAKE_LINES), 2600);
			}
			// 图片加载失败时的内联 SVG 占位（只改 src，绝不新增 DOM 元素，避免"多一只"）
			const FALLBACK_SVG = "data:image/svg+xml;utf8," + encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><text x="50%" y="54%" font-size="140" text-anchor="middle">🐳</text></svg>'
			);
			showStatic();
			staticImg.src = FRAMES.idle;
			staticImg.addEventListener("error", () => {
				if (staticImg.getAttribute("src") !== FALLBACK_SVG) {
					staticImg.src = FALLBACK_SVG;
				}
			});
			// 动图加载失败兜底：优雅回静帧，避免"微笑被截断成空白"
			animImg.addEventListener("error", () => {
				if (animImg.style.display !== "none") stopAnim();
			});

			// 4. 气泡控制
			let bubbleTimer = null;
			function showBubble(text, duration) {
				bubbleActions.classList.remove("show");
				bubbleText.textContent = text;
				bubble.classList.add("show");
				if (bubbleTimer) clearTimeout(bubbleTimer);
				bubbleTimer = setTimeout(() => bubble.classList.remove("show"), duration || 3200);
			}
			// 4b. 语音播放（点击/确认时，与气泡文案用同一索引，保证说与显示一致）
			// 互斥：播新语音前先停掉所有正在播的语音，避免确认/点击两条语音叠加
			// 注意：必须用全局 jbStopAllVoices（停全局 jbVoiceCache），
			// 不能停局部 voiceCache —— apply 重入时两个实例的局部池互不相通，会双双播放！
			function playVoiceIndex(group, idx) {
				try {
					// 实例代际检查：旧 apply 实例的残留监听（document 级）触发时拒绝播放，杜绝多声音叠加
					if (myApplyId !== jbActiveApplyId) return;
					// 语音总开关（主菜单「🔊 语音播报」checkbox）：关闭 → 所有播报不响
					if (monitor && monitor.voiceAll === false) return;
					// 语音开关：confirm→voiceConfirm / ask→voiceAsk / poke→voicePoke / done→voiceDone（右键菜单控制）
					const voiceKey = group === "confirm" ? "voiceConfirm" : group === "ask" ? "voiceAsk" : group === "poke" ? "voicePoke" : group === "done" ? "voiceDone" : null;
					if (voiceKey && monitor && monitor[voiceKey] === false) return;  // 该语音已关闭 → 不播
					const list = voiceCache[group];
					if (!list || !list[idx]) return;
					if (monitor && monitor.voiceMuted === true) return;  // 全局静音（小喇叭🔇 状态，恢复时从暂停处继续）
					// 新语音播放：清掉旧的暂停记录（新播报优先，不再继续旧的）
					jbPausedVoice = null;
					jbPausedAt = 0;
					jbStopAllVoices();             // 停全局池（无脑 pause，跨实例互斥）
					const a = list[idx];
					a.currentTime = 0;             // 从头播放（预加载好，无延迟）
					// 音量条（默认 70，留出上调空间）
					const vol = monitor && typeof monitor.voiceVolume === "number"
						? Math.max(0, Math.min(1, monitor.voiceVolume / 100))
						: 0.7;
					a.volume = vol;
					a.play().catch(() => {});
				} catch (e) { /* 忽略 */ }
			}

			// 5. 点击互动（弹跳 + 幸福摇头 + 爱心飞走特效）
			let hopTimer = null;
			body.addEventListener("click", (e) => {
				if (petDragged) { petDragged = false; return; }  // 拖拽结束不算点击
				lastActivity = Date.now();
				if (sleepyFlag) {
					// 瞌睡中被点击：直接唤醒（播打断动画），不做普通互动
					wakeUp();
					return;
				}
				body.classList.remove("jb-hop");
				void body.offsetWidth;
				body.classList.add("jb-hop");
				if (hopTimer) clearTimeout(hopTimer);
				hopTimer = setTimeout(() => body.classList.remove("jb-hop"), 640);
				// 点击互动：50% 幸福摇头 / 50% 双手比心（比心 5.2s 完整循环）
				if (Math.random() < 0.5) {
					playAnim("shake", 3200);
				} else {
					playAnim("heart", 5400);
				}
				spawnHearts(e.clientX, e.clientY);
				// 点击后 5 秒内不让随机卖萌/微笑计时器顶替当前动画
				idleBlockedUntil = Date.now() + 5000;
				// 气泡与语音用同一句（索引同步）
				const pokeIdx = Math.floor(Math.random() * POKE_LINES.length);
				showBubble(POKE_LINES[pokeIdx]);
				playVoiceIndex("poke", pokeIdx);  // 语音与气泡同句
			});
			// 爱心飞走特效：从点击处生成若干小爱心，向上飘散淡出
			function spawnHearts(x, y) {
				const EMOJIS = ["❤️", "💕", "💗", "💖", "❤️"];
				const count = 4 + Math.floor(Math.random() * 3);
				for (let i = 0; i < count; i += 1) {
					const h = document.createElement("span");
					h.className = "jb-heart";
					h.textContent = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
					h.style.left = (x + (Math.random() - 0.5) * 20) + "px";
					h.style.top = (y + (Math.random() - 0.5) * 20) + "px";
					h.style.setProperty("--dx", ((Math.random() - 0.5) * 70) + "px");
					h.style.fontSize = (13 + Math.random() * 15) + "px";
					h.style.animationDelay = (Math.random() * 0.18) + "s";
					document.body.appendChild(h);
					setTimeout(() => h.remove(), 1600);
				}
			}
			// 5c. 主人聚焦输入框准备打字时，鲸宝回应（拟人陪伴）
			let lastInputGreetAt = 0;
			document.addEventListener("focusin", (e) => {
				const t = e.target;
				const isInput = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable === true);
				if (!isInput) return;
				if (sleepyFlag || animTimer) return;
				const now = Date.now();
				if (now - lastInputGreetAt > 30000) {
					lastInputGreetAt = now;
					showBubble(pick(INPUT_LINES), 2600);
				}
			});

			// 5d. 拖拽移动桌宠（拖到任意位置；拖拽结束不算点击）
			let petDragging = false;
			let petDragged = false;
			let dragStartX = 0, dragStartY = 0, dragLeft = 0, dragTop = 0;
			body.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				petDragging = true;
				petDragged = false;
				dragStartX = e.clientX;
				dragStartY = e.clientY;
				const rect = root.getBoundingClientRect();
				dragLeft = rect.left;
				dragTop = rect.top;
				playAnimLoop("grab");  // 被抓住动画（按住期间循环播放）
			});
			document.addEventListener("mousemove", (e) => {
				if (!petDragging) return;
				const dx = e.clientX - dragStartX;
				const dy = e.clientY - dragStartY;
				if (Math.abs(dx) + Math.abs(dy) > 6) petDragged = true;
				if (petDragged) {
					root.style.right = "auto";
					root.style.bottom = "auto";
					root.style.left = Math.round(dragLeft + dx) + "px";
					root.style.top = Math.round(dragTop + dy) + "px";
				}
			});
			document.addEventListener("mouseup", () => {
				if (petDragging) {
					petDragging = false;
					stopAnim();  // 放开后回归正常静帧
					// 保存拖拽后的位置（页面重载后恢复）
					const rect = root.getBoundingClientRect();
					try {
						localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
					} catch (e) { /* ignore */ }
				}
			});
			// 5e. 滚轮缩放（向上放大 / 向下缩小，范围 128~512）
			body.addEventListener("wheel", (e) => {
				e.preventDefault();
				petHeight = Math.max(PET_HEIGHT_MIN, Math.min(PET_HEIGHT_MAX, petHeight + (e.deltaY < 0 ? 48 : -48)));
				applyPetSize();
			}, { passive: false });
			// 5f. 右键菜单 + 系统监控（CPU/内存/显卡，数据来自本地 8765 监控服务）
			//      + 语音播报开关（确认/点击/任务完成，默认全开）
			const MONITOR_KEY = "dsh.pet.monitor.v1";
			let monitor = { enabled: false, cpu: true, mem: true, gpu: true, voiceAll: true, voiceConfirm: true, voiceAsk: true, voicePoke: true, voiceDone: true, voiceVolume: 70, voiceMuted: false, balanceEnabled: false, balanceInterval: 5 };
			let jbPausedVoice = null;  // 小喇叭🔇 暂停的语音 Audio（🔊 恢复时从暂停处继续播）
			let jbPausedAt = 0;        // 暂停位置（秒）
			try {
				monitor = Object.assign(monitor, JSON.parse(localStorage.getItem(MONITOR_KEY) || "{}"));
			} catch (e) { /* ignore */ }
			function saveMonitor() {
				try { localStorage.setItem(MONITOR_KEY, JSON.stringify(monitor)); } catch (e) { /* ignore */ }
			}
			function renderMenu() {
				menu.querySelectorAll("input[data-k]").forEach((cb) => {
					if (cb.type === "range") return;  // 音量条单独处理
					const k = cb.dataset.k;
					cb.checked = monitor[k] === true;
					// 监控子项受 enabled 控制；语音子项受 voiceAll 总开关控制（语音总开关独立于监控）
					const isMonSub = k === "cpu" || k === "mem" || k === "gpu";
					const isVoiceSub = k === "voiceConfirm" || k === "voiceAsk" || k === "voicePoke" || k === "voiceDone";
					const subDisabled = (isMonSub && !monitor.enabled) || (isVoiceSub && monitor.voiceAll === false);
					cb.disabled = subDisabled;
					cb.parentElement.style.opacity = subDisabled ? "0.45" : "1";
				});
				// 音量条 + 静音按钮
				const range = menu.querySelector("input[data-k='voiceVolume']");
				if (range) range.value = String(typeof monitor.voiceVolume === "number" ? monitor.voiceVolume : 70);
				const muteBtn = menu.querySelector("button[data-k='voiceMute']");
				if (muteBtn) muteBtn.textContent = monitor.voiceMuted ? "🔇" : "🔊";
				// 余额刷新间隔滑条 + 显示
				const balRange = menu.querySelector("input[data-k='balanceInterval']");
				if (balRange) balRange.value = String(typeof monitor.balanceInterval === "number" ? monitor.balanceInterval : 5);
				const balVal = menu.querySelector("[data-interval-val]");
				if (balVal) balVal.textContent = (typeof monitor.balanceInterval === "number" ? monitor.balanceInterval : 5) + " 分";
			}
			body.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				// 打开菜单时重置：收起所有子菜单 + 隐藏手册面板
				menu.querySelectorAll(".jb-menu-parent").forEach((p) => p.classList.remove("open"));
				helpPanel.style.display = "none";
				renderMenu();
				menu.style.display = "block";
				menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - 180)) + "px";
				menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - 110)) + "px";  // 瘦身后菜单更矮
			});
			document.addEventListener("mousedown", (e) => {
				if (!menu.contains(e.target)) menu.style.display = "none";
				if (!helpPanel.contains(e.target)) helpPanel.style.display = "none";
			});
			menu.addEventListener("click", (e) => {
				// 检查更新：对比 GitHub 版本号
				if (e.target.closest(".jb-menu-update-check")) {
					checkPetUpdate(true);  // 主动检查（强制刷新缓存）
					return;
				}
				// 立即更新：下载新版并替换（node 服务端执行，重启生效）
				if (e.target.closest(".jb-menu-update-do")) {
					menu.style.display = "none";
					showBubble("主人，鲸宝正在更新自己～马上就好～", 4000);
					fetch("http://127.0.0.1:8765/do-update")
						.then((r) => r.json())
						.then((d) => {
							if (d && d.ok) {
								showBubble("更新完成！主人重启 dsh web 就能用新版鲸宝啦～", 5000);
								playVoiceIndex("done", 0);
							} else {
								showBubble("呜…更新失败了：" + ((d && d.message) || "未知错误"), 5000);
							}
						})
						.catch(() => showBubble("呜…更新服务连不上，主人检查一下 DSH 吧～", 4000));
					return;
				}
				// 操控手册：显示说明面板
				if (e.target.closest(".jb-menu-help")) {
					menu.style.display = "none";
					helpPanel.style.display = "block";
					helpPanel.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - 320)) + "px";
					helpPanel.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - 320)) + "px";
					return;
				}
				// 静音按钮（暂停/继续语义，人性化设计）：🔇 暂停正在播的语音并记住位置，🔊 从暂停处继续播
				const muteBtn = e.target.closest("button[data-k='voiceMute']");
				if (muteBtn) {
					monitor.voiceMuted = !monitor.voiceMuted;
					saveMonitor();
					renderMenu();
					if (monitor.voiceMuted) {
						// 暂停：记录正在播的语音及其位置（在 jbStopAllVoices 清零前抓取）
						jbPausedVoice = null;
						jbPausedAt = 0;
						try {
							if (jbVoiceCache) {
								outer:
								for (const g of Object.keys(jbVoiceCache)) {
									for (const a of (jbVoiceCache[g] || [])) {
										if (a && !a.paused && a.currentTime > 0 && a.readyState >= 2) {
											jbPausedVoice = a;
											jbPausedAt = a.currentTime;
											break outer;
										}
									}
								}
							}
						} catch (e) { /* ignore */ }
						jbStopAllVoices();
					} else {
						// 继续：从暂停处接着播（用户点击手势，不会被自动播放策略拦截）
						if (jbPausedVoice) {
							const pv = jbPausedVoice;
							const pa = jbPausedAt;
							jbPausedVoice = null;
							jbPausedAt = 0;
							try {
								pv.currentTime = pa;
								const vol = monitor && typeof monitor.voiceVolume === "number"
									? Math.max(0, Math.min(1, monitor.voiceVolume / 100))
									: 0.7;
								pv.volume = vol;
								pv.play().catch(() => {});
							} catch (e2) { /* ignore */ }
						}
					}
					return;
				}
				const cb = e.target.closest("input[data-k]:not([type='range'])");
				if (!cb) return;
				const k = cb.dataset.k;
				if (k === "enabled") monitor.enabled = cb.checked;
				else if (k === "cpu" || k === "mem" || k === "gpu") {
					if (monitor.enabled) monitor[k] = cb.checked;
				} else {
					// 语音开关：独立控制，不受监控开关影响
					monitor[k] = cb.checked;
				}
				saveMonitor();
				renderMenu();
				startMonitor();
				startBalance();  // 余额开关/间隔变化时响应
			});
			// 手动刷新余额按钮
			menu.addEventListener("click", (e) => {
				const refreshBtn = e.target.closest("button[data-balance-refresh]");
				if (refreshBtn) {
					showBubble("鲸宝正在查询余额～稍等～", 2200);
					fetchBalance();
					return;
				}
			});
			// 子菜单 hover 展开（CSS 处理显示），这里只负责弹出方向自适应：
			// 主菜单靠近右边缘时子菜单向左弹（否则会被屏幕截断）
			menu.addEventListener("mouseover", (e) => {
				const parent = e.target.closest(".jb-menu-parent");
				if (!parent) return;
				const sub = parent.querySelector(".jb-menu-sub");
				if (!sub) return;
				const mr = menu.getBoundingClientRect();
				sub.classList.toggle("flip", mr.left + mr.width + 210 > window.innerWidth);
			});
			// 手册面板「知道了」按钮（面板是独立元素，事件不冒泡到菜单）
			helpPanel.addEventListener("click", (e) => {
				if (e.target.closest(".jb-help-close")) helpPanel.style.display = "none";
			});
			// 半自动更新检查：调 node 服务端 /check-update 对比 GitHub 版本号
			// visible=true（菜单主动检查）时无论结果都提示；false（启动静默）时只有新版本才提示
			function checkPetUpdate(visible) {
				const doBtn = menu.querySelector(".jb-menu-update-do");
				fetch("http://127.0.0.1:8765/check-update")
					.then((r) => r.json())
					.then((d) => {
						if (d && d.hasUpdate) {
							showBubble("主人，鲸宝有新版本 " + (d.latest || "") + " 啦～右键菜单点「⬇️ 立即更新」就能升级哦～", 5000);
							if (doBtn) doBtn.style.display = "block";
						} else if (visible) {
							showBubble("主人，鲸宝已经是最新版本 " + (d ? d.current : PET_VERSION) + " 啦～", 3200);
						}
					})
					.catch(() => {
						if (visible) showBubble("呜…检查更新失败了，主人稍后再试试～", 3200);
					});
			}
			// 启动时静默检查一次（有新版才提醒）
			setTimeout(() => checkPetUpdate(false), 5000);
			// 音量条：拖动实时生效（input 事件）——音量实时应用到语音池，正在播的立即变音量
			menu.addEventListener("input", (e) => {
				// 音量条
				const range = e.target.closest("input[data-k='voiceVolume']");
				if (range) {
					monitor.voiceVolume = parseInt(range.value, 10);
					if (isNaN(monitor.voiceVolume)) monitor.voiceVolume = 70;
					saveMonitor();
					jbApplyVoiceVolume(monitor);  // 实时应用到所有 Audio（含正在播的）
					return;
				}
				// 余额刷新间隔滑条（1~60 分钟）
				const balRange = e.target.closest("input[data-k='balanceInterval']");
				if (balRange) {
					monitor.balanceInterval = parseInt(balRange.value, 10);
					if (isNaN(monitor.balanceInterval)) monitor.balanceInterval = 5;
					saveMonitor();
					startBalance();  // 重启定时器
					const iv = menu.querySelector("[data-interval-val]");
					if (iv) iv.textContent = monitor.balanceInterval + " 分";
				}
			});
			// 监控轮询 + 余额显示（余额并入性能监测第二行）
			let statsTimer = null;
			let balanceTimer = null;
			function positionMonitor() {
				// 固定显示在鲸宝下方
				monitorPanel.style.top = "calc(100% + 10px)";
				monitorPanel.style.bottom = "auto";
			}
			/** 统一控制性能监测框显隐：性能参数 或 余额 任一有内容才显示。
			 *  第一行（性能）为空时隐藏并去掉第二行的上间距，保证只有余额时垂直居中。 */
			function updateMonitorDisplay() {
				const hasPerf = monitor.enabled && monitorText.textContent.trim();
				// 第一行显隐
				monitorText.style.display = hasPerf ? "" : "none";
				// 第二行上间距：第一行隐藏时归零（避免偏上不居中）
				monitorBal.style.marginTop = hasPerf ? "" : "0";
				const hasBal = monitor.balanceEnabled && monitorBal.style.display !== "none";
				if (hasPerf || hasBal) { monitorPanel.style.display = "block"; positionMonitor(); }
				else monitorPanel.style.display = "none";
			}
			function fetchStats() {
				fetch("http://127.0.0.1:8765/stats")
					.then((r) => r.json())
					.then((d) => {
						const parts = [];
						if (monitor.cpu) parts.push("CPU " + d.cpu + "%");
						if (monitor.mem) parts.push("内存 " + d.mem + "%");
						if (monitor.gpu && d.gpu) parts.push("GPU " + d.gpu.usage + "%");
						monitorText.innerHTML = parts.join("&nbsp;&nbsp;");
						updateMonitorDisplay();
					})
					.catch(() => { monitorText.textContent = ""; updateMonitorDisplay(); });
			}
			function startMonitor() {
				if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
				if (monitor.enabled) {
					fetchStats();
					statsTimer = setInterval(fetchStats, 1000);
				} else {
					monitorText.textContent = "";
					updateMonitorDisplay();
				}
			}
			startMonitor();

			// 余额显示（DeepSeek /user/balance，前端经 index.js /balance 获取；key 存 server 端自动读本地凭证）
			/** 更新菜单里的余额数值框。 */
			function updateAmountBox(text, isErr) {
				const amountBox = menu.querySelector("[data-balance-amount]");
				if (amountBox) { amountBox.textContent = text; amountBox.classList.toggle("jb-amount-error", !!isErr); }
			}
			function fetchBalance() {
				if (!monitor.balanceEnabled) { monitorBal.style.display = "none"; updateMonitorDisplay(); return; }
				fetch("http://127.0.0.1:8765/balance")
					.then((r) => r.json())
					.then((d) => {
						if (!monitor.balanceEnabled) { monitorBal.style.display = "none"; updateMonitorDisplay(); return; }
						if (d && d.ok && d.balance_infos && d.balance_infos.length) {
							const sum = d.balance_infos.map((b) => (b.currency === "USD" ? "$" : "¥") + b.total_balance).join(" / ");
							monitorAmount.textContent = sum;
							monitorBal.style.display = "block";
							updateAmountBox(sum);
						} else if (d && d.error === "no_key") {
							monitorAmount.textContent = "未配置";
							monitorBal.style.display = "block";
							updateAmountBox("未配置 Key", true);
						} else {
							monitorAmount.textContent = "获取失败";
							monitorBal.style.display = "block";
							updateAmountBox("获取失败", true);
						}
						updateMonitorDisplay();
					})
					.catch(() => {
						if (monitor.balanceEnabled) { monitorAmount.textContent = "服务不可用"; monitorBal.style.display = "block"; updateMonitorDisplay(); }
					});
			}
			function startBalance() {
				if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; }
				if (monitor.balanceEnabled) {
					fetchBalance();
					balanceTimer = setInterval(fetchBalance, Math.max(1, monitor.balanceInterval) * 60 * 1000);
				} else {
					monitorBal.style.display = "none";
					updateAmountBox("未查询");
					updateMonitorDisplay();
				}
			}
			startBalance();

			// 6. 活跃检测 → 长时间无操作进入瞌睡，恢复时醒来
			const onActivity = () => {
				lastActivity = Date.now();
				if (sleepyFlag) wakeUp();
			};
			["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel", "pointerdown"].forEach((ev) => {
				document.addEventListener(ev, onActivity, { passive: true });
			});
			setInterval(() => {
				if (!sleepyFlag && Date.now() - lastActivity > SLEEPY_AFTER_MS) {
					startSleepy();
				}
			}, 2000);

			// 7. 整点报时（挥手 + 时段问候）
			setInterval(() => {
				const d = new Date();
				if (d.getMinutes() === 0 && d.getHours() !== lastReportedHour) {
					lastReportedHour = d.getHours();
					sleepyFlag = false;
					lastActivity = Date.now();
					playAnim("wave", 3800);
					showBubble(timeGreeting(d), 5200);
				}
			}, 20000);

			// 8. 劝休息 / 深夜关怀
			setInterval(() => {
				const now = Date.now();
				const hour = new Date().getHours();
				const isNight = hour >= 22 || hour < 6;
				if (now - lastRestRemindAt < REST_INTERVAL_MS) return;
				const activeMs = now - SESSION_START;
				if (activeMs > REST_AFTER_MS) {
					lastRestRemindAt = now;
					showBubble(pick(REST_LINES), 6000);
				} else if (isNight) {
					lastRestRemindAt = now;
					showBubble(pick(NIGHT_LINES), 6000);
				}
			}, 30000);

			// 9. 确认联动：检测到确认弹窗 → 鲸宝冒泡提示（不自动消失、暂停随机动作）；
			//    主人处理完（弹窗关闭/按钮点击）→ 气泡立即消失并恢复随机动作
			// v5.3 多弹窗化：DSH 连续弹窗（间隔 ~220ms）时，每个弹窗独立跟踪，
			//    修复「单引用被覆盖 → 第一个弹窗漏播 / 处理完气泡不消失」的 bug
			let pendingConfirmList = [];  // 挂起的确认弹窗列表（每个条目 {yesBtn, noBtn, container}）
			let lastAnnouncedKey = null;  // 最近播报过的确认的特征 key（记录用）
			/** 生成确认弹窗的特征 key：只取按钮文本（最稳定；summary/text 在重渲染时可能缺失/变化）。 */
			function confirmKey(info) {
				try {
					const parts = [];
					if (info.yesBtn) parts.push("Y:" + (info.yesBtn.textContent || "").trim().slice(0, 12));
					if (info.noBtn) parts.push("N:" + (info.noBtn.textContent || "").trim().slice(0, 12));
					return parts.join("|") || "";
				} catch (e) { return ""; }
			}
			let lastHandledBtns = [];  // 刚处理完的确认弹窗的按钮元素（残留识别：同一元素再出现 = 残留）
			let lastHandledAt = 0;
			let lastHandledKey = null;  // 刚处理完的弹窗特征 key（React 重渲染会重建按钮元素、元素 === 失效，用 key 兜底）
			const CONFIRM_HANDLE_WINDOW = 3000;  // 处理完 3s 内，同一按钮元素/同 key 视为残留（批准后残留/自动批准停留通常 <3s）
			const announcedBtns = new WeakSet();  // 已播报过的按钮元素（同按钮不重复播；WeakSet 不阻止 GC）
			let lastAnnouncedBtn = null;   // 最近播报的按钮元素（按钮级短窗口去重：同一弹窗多批次信号只播一次）
			let lastAnnouncedBtnAt = 0;
			const ANNOUNCE_BTN_WINDOW = 2500;  // 同一按钮 2.5s 内不重复播
			/** 处理完一个弹窗条目：记录残留信息、从列表移除；列表清空才收尾（清气泡 + 恢复）。 */
			function finishConfirm(entry) {
				const idx = pendingConfirmList.indexOf(entry);
				if (idx === -1) return;
				pendingConfirmList.splice(idx, 1);
				// 记录刚处理弹窗的按钮元素（React 关闭动画/重渲染时这些元素可能还在 → 识别为残留）
				lastHandledBtns = [];
				if (entry.yesBtn) lastHandledBtns.push(entry.yesBtn);
				if (entry.noBtn) lastHandledBtns.push(entry.noBtn);
				lastHandledKey = confirmKey(entry);  // 同 key 兜底（按钮被 React 重建时用）
				lastHandledAt = Date.now();
				if (pendingConfirmList.length === 0) {
					bubbleActions.classList.remove("show");
					bubble.classList.remove("show");
					if (!pendingAsk) resumeIdleTimer();  // 提问事件还挂着就不恢复
				}
			}
			function showConfirmBubble(info) {
				// 只提示符合人设的话语（不带按钮、不自动消失）
				const cIdx = Math.floor(Math.random() * CONFIRM_LINES.length);
				bubbleText.textContent = CONFIRM_LINES[cIdx];
				bubbleActions.classList.remove("show");
				bubble.classList.add("show");
				if (bubbleTimer) clearTimeout(bubbleTimer);  // 清掉普通气泡的自动关闭定时器
				stopIdleTimer();  // 暂停随机动作计时器
				playVoiceIndex("confirm", cIdx);  // 语音与气泡同句
				pendingConfirmList.push(info);  // 多弹窗：各自入列，互不覆盖
				// 主人点击弹窗里的同意/拒绝按钮 → 该弹窗处理完
				const onBtn = () => finishConfirm(info);
				if (info.yesBtn) info.yesBtn.addEventListener("click", onBtn, { once: true });
				if (info.noBtn) info.noBtn.addEventListener("click", onBtn, { once: true });
				trackConfirmFallback();  // 终极兜底：轮询检查确认按钮是否还在页面上
			}
			// 终极兜底：定期检查页面里是否还存在「确认/取消」类按钮；
			// 全部弹窗关闭（按钮都被移除）→ 清空列表 + 气泡消失 + 恢复随机动作
			function trackConfirmFallback() {
				if (pendingConfirmList.length === 0) return;  // 无挂起确认时停止轮询
				let hasBtn = false;
				try {
					const all = document.querySelectorAll("button, [role='button']");
					for (let i = 0; i < all.length; i += 1) {
						const t = (all[i].textContent || "").trim();
						if (t && t.length <= 12 && (CONFIRM_CONTAINS.test(t) || CANCEL_CONTAINS.test(t))) {
							hasBtn = true;
							break;
						}
					}
				} catch (e) { /* ignore */ }
				if (!hasBtn) {
					// 页面已无任何确认按钮：所有挂起弹窗都已关闭 → 整批收尾
					const lastEntry = pendingConfirmList[pendingConfirmList.length - 1];
					if (lastEntry) {
						lastHandledBtns = [];
						if (lastEntry.yesBtn) lastHandledBtns.push(lastEntry.yesBtn);
						if (lastEntry.noBtn) lastHandledBtns.push(lastEntry.noBtn);
						lastHandledKey = confirmKey(lastEntry);
						lastHandledAt = Date.now();
					}
					pendingConfirmList = [];
					bubbleActions.classList.remove("show");
					bubble.classList.remove("show");
					if (!pendingAsk) resumeIdleTimer();
					return;
				}
				setTimeout(trackConfirmFallback, 500);
			}
			let lastConfirmAt = 0;
			const mo = new MutationObserver((muts) => {
				// 弹窗被移除/隐藏（ESC、遮罩、React 隐藏）→ 逐个移除对应条目
				if (pendingConfirmList.length > 0) {
					for (let k = pendingConfirmList.length - 1; k >= 0; k -= 1) {
						const c = pendingConfirmList[k].container;
						if (!c) continue;
						let hidden = false;
						try {
							const st = window.getComputedStyle(c);
							hidden = st.display === "none" || st.visibility === "hidden";
						} catch (e) { /* ignore */ }
						if (!document.contains(c) || hidden) finishConfirm(pendingConfirmList[k]);
					}
				}
				for (let i = 0; i < muts.length; i += 1) {
					const added = muts[i].addedNodes;
					for (let j = 0; j < added.length; j += 1) {
						const info = findConfirmSignal(added[j]);
						if (info) {
							const now = Date.now();
							const key = confirmKey(info);
							// 已播报过的按钮（同一弹窗重复信号）→ 不重复播
							if ((info.yesBtn && announcedBtns.has(info.yesBtn)) ||
								(info.noBtn && announcedBtns.has(info.noBtn))) return;
							// 残留识别：信号按钮是"刚处理完弹窗"的同一个按钮元素，且在 1.5s 窗口内 → 残留
							// （React 关闭动画/重渲染会复用同一按钮元素；新弹窗的按钮是全新元素）
							const nowH = Date.now();
							const isHandledBtn = lastHandledBtns.length > 0 && nowH - lastHandledAt < CONFIRM_HANDLE_WINDOW &&
								((info.yesBtn && lastHandledBtns.indexOf(info.yesBtn) !== -1) ||
								 (info.noBtn && lastHandledBtns.indexOf(info.noBtn) !== -1));
							if (isHandledBtn) return;
							// React 重建防线：刚处理完的弹窗（窗口内）若出现**同 key** 信号 → 大概率是同一弹窗
							// 重渲染产生的新按钮元素（元素 === 比对会失效）→ 用更长验证窗口甄别：
							//   残留（重渲染中间态，即将随弹窗关闭移除）→ 1s 后验证不在 → 不播
							//   真新需求（稳定存在）→ 1s 后验证还在 → 播（不误杀，区别于 README 旧失败方案）
							const isRecentHandledKey = lastHandledKey && nowH - lastHandledAt < CONFIRM_HANDLE_WINDOW &&
								key && key === lastHandledKey;
							// 残留窗口已过期：清空按钮引用（不持有 DOM 引用，无内存残留）
							if (lastHandledBtns.length > 0 && nowH - lastHandledAt >= CONFIRM_HANDLE_WINDOW) {
								lastHandledBtns = [];
								lastHandledAt = 0;
								lastHandledKey = null;
							}
							// 延迟验证法：每个信号**独立**调度（不互相取消——多弹窗要各自播报），
							// 验证"信号自己的按钮是否还在页面上"（不检查页面其他按钮，避免误判）。
							const schedInfo = info;
							const verifyDelay = isRecentHandledKey ? 1000 : 400;
							setTimeout(() => {
								// 验证：信号自己的按钮还在页面上吗？
								let stillThere = false;
								try {
									if (schedInfo.yesBtn && document.contains(schedInfo.yesBtn)) stillThere = true;
									else if (schedInfo.noBtn && document.contains(schedInfo.noBtn)) stillThere = true;
								} catch (e) { /* ignore */ }
								if (!stillThere) return;  // 按钮已消失 = 残留 → 不播
								// 已处理/已批准状态检查：按钮被禁用（disabled）说明弹窗已被处理或 DSH 自动批准中 →
								// 主人不需要确认，不播（修复「批准后 pwsh 免批执行却误播确认语音」）
								try {
									const liveBtn = (schedInfo.yesBtn && document.contains(schedInfo.yesBtn)) ? schedInfo.yesBtn : schedInfo.noBtn;
									if (liveBtn && (liveBtn.disabled === true || liveBtn.getAttribute("aria-disabled") === "true")) return;
								} catch (e) { /* ignore */ }
								const t2 = Date.now();
								// 验证通过后再查一次已播（400ms 内可能已被其他信号播过同一按钮）
								const btnRef = schedInfo.yesBtn || schedInfo.noBtn;
								if (btnRef && (announcedBtns.has(btnRef) ||
									(btnRef === lastAnnouncedBtn && t2 - lastAnnouncedBtnAt < ANNOUNCE_BTN_WINDOW))) return;
								// 真弹窗：播报（覆盖上一条未播完的语音，但每个弹窗都播一次）
								if (t2 - lastConfirmAt >= 200) {  // 极小防抖，避免同批次重复调度
									lastConfirmAt = t2;
									lastAnnouncedKey = key;
									if (schedInfo.yesBtn) announcedBtns.add(schedInfo.yesBtn);
									if (schedInfo.noBtn) announcedBtns.add(schedInfo.noBtn);
									if (btnRef) { lastAnnouncedBtn = btnRef; lastAnnouncedBtnAt = t2; }
									showConfirmBubble(schedInfo);
								}
							}, verifyDelay);
							return;
						}
					}
				}
			});
			// 全局唯一 MO：apply 重入时先断开旧的，保证同一时刻只有一个观察器
			if (jbConfirmMO) { try { jbConfirmMO.disconnect(); } catch (e) { /* 忽略 */ } }
			jbConfirmMO = mo;
			mo.observe(document.body, { childList: true, subtree: true });
			// 兜底：挂起确认期间，主人点击任意「同意/取消」类按钮 → 该需求已处理，气泡消失
			// （宽松包含匹配，覆盖「同意并继续」「确认授权」等组合文案；React 重建也不怕）
			document.addEventListener("click", (e) => {
				if (pendingConfirmList.length === 0) return;
				const btn = e.target.closest("button, [role='button']");
				if (!btn) return;
				const text = (btn.textContent || "").trim();
				if (text && text.length <= 12 && (CONFIRM_CONTAINS.test(text) || CANCEL_CONTAINS.test(text))) {
					// 找到包含被点按钮的挂起条目（找不到则处理最后一个）
					const entry = pendingConfirmList.find((it) => (it.yesBtn === btn) || (it.noBtn === btn)) ||
						pendingConfirmList[pendingConfirmList.length - 1];
					if (entry) setTimeout(() => finishConfirm(entry), 350);  // 稍等弹窗关闭
				}
			}, true);

			// 9a2. 提问提醒：agent 用 ask_user_question 问主人「接下来怎么选」的提问框（v5.1 新增）
			// DSH 提问框稳定锚点：外层 `data-question-key`（通用提问）/ `data-plan-review-key`（plan review）
			// 出现 → 冒泡 + 语音（voice_ask）；主人提交/跳过/取消后提问框被移除 → 气泡消失恢复
			let pendingAsk = null;          // 挂起的提问（记录提问框容器）
			let lastAskKey = null;          // 最近播报过的提问 key（同框去重）
			let lastAskHandledKey = null;   // 刚处理完的提问 key（React 重建防线：元素会被重建，用 key 兜底）
			let lastAskHandledAt = 0;
			const ASK_HANDLE_WINDOW = 1500; // 处理完 1.5s 内同 key 视为残留
			let lastAskAt = 0;
			let pendingAskAnnounce = null;
			/** 提问框特征 key：优先 data-question-key / data-plan-review-key（最稳定），兜底取文本。 */
			function askKey(el) {
				try {
					const q = el.getAttribute("data-question-key");
					if (q) return "Q:" + q;
					const p = el.getAttribute("data-plan-review-key");
					if (p) return "P:" + p;
				} catch (e) { /* ignore */ }
				try {
					const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
					if (t) return "T:" + t;
				} catch (e) { /* ignore */ }
				return "";
			}
			/** 在新增节点里定位提问框容器（自身或后代带锚点属性）。 */
			function findAskSignal(node) {
				if (!node || node.nodeType !== 1) return null;
				try {
					if (node.hasAttribute && (node.hasAttribute("data-question-key") || node.hasAttribute("data-plan-review-key"))) return node;
					if (node.querySelector) {
						const el = node.querySelector("[data-question-key], [data-plan-review-key]");
						if (el) return el;
					}
				} catch (e) { /* ignore */ }
				return null;
			}
			function finishAsk() {
				if (!pendingAsk) return;
				lastAskHandledKey = askKey(pendingAsk.container);
				lastAskHandledAt = Date.now();
				pendingAsk = null;
				bubbleActions.classList.remove("show");
				bubble.classList.remove("show");
				if (pendingConfirmList.length === 0) resumeIdleTimer();  // 确认事件还挂着就不恢复
			}
			function showAskBubble(container) {
				const aIdx = Math.floor(Math.random() * ASK_LINES.length);
				bubbleText.textContent = ASK_LINES[aIdx];
				bubbleActions.classList.remove("show");
				bubble.classList.add("show");
				if (bubbleTimer) clearTimeout(bubbleTimer);
				stopIdleTimer();
				playVoiceIndex("ask", aIdx);
				pendingAsk = { container };
				trackAskFallback();
			}
			/** 兜底轮询：页面上提问框锚点不存在 = 已处理完。 */
			function trackAskFallback() {
				if (!pendingAsk) return;
				let still = false;
				try {
					const el = document.querySelector("[data-question-key], [data-plan-review-key]");
					if (el && document.contains(el)) still = true;
				} catch (e) { /* ignore */ }
				if (!still && pendingAsk) { finishAsk(); return; }
				setTimeout(trackAskFallback, 500);
			}
			const askMo = new MutationObserver((muts) => {
				// 挂起提问的容器消失/隐藏（提交/跳过/取消后 React 移除）→ 处理完
				if (pendingAsk && pendingAsk.container) {
					const c = pendingAsk.container;
					let hidden = false;
					try {
						const st = window.getComputedStyle(c);
						hidden = st.display === "none" || st.visibility === "hidden";
					} catch (e) { /* ignore */ }
					if (!document.contains(c) || hidden) finishAsk();
				}
				for (let i = 0; i < muts.length; i += 1) {
					const added = muts[i].addedNodes;
					for (let j = 0; j < added.length; j += 1) {
						const el = findAskSignal(added[j]);
						if (!el) continue;
						const now = Date.now();
						const key = askKey(el);
						// 同框去重：当前挂起且 key 相同 → 不重复播
						if (pendingAsk && lastAskKey && key && key === lastAskKey) return;
						// 刚处理完（窗口内）同 key → React 重渲染残留 → 长验证窗口甄别
						const isRecentHandled = lastAskHandledKey && now - lastAskHandledAt < ASK_HANDLE_WINDOW && key && key === lastAskHandledKey;
						if (lastAskHandledKey && now - lastAskHandledAt >= ASK_HANDLE_WINDOW) {
							lastAskHandledKey = null;
							lastAskHandledAt = 0;
						}
						if (pendingAskAnnounce) { clearTimeout(pendingAskAnnounce); pendingAskAnnounce = null; }
						const schedEl = el;
						const verifyDelay = isRecentHandled ? 1000 : 400;
						pendingAskAnnounce = setTimeout(() => {
							pendingAskAnnounce = null;
							// 延迟验证：提问框自己还在页面上吗？（残留会被 React 移除）
							let still = false;
							try {
								if (document.contains(schedEl)) still = true;
							} catch (e) { /* ignore */ }
							if (!still) return;
							const t2 = Date.now();
							if (t2 - lastAskAt >= 200) {  // 极小防抖
								lastAskAt = t2;
								lastAskKey = key;
								showAskBubble(schedEl);
							}
						}, verifyDelay);
						return;
					}
				}
			});
			// 全局唯一：apply 重入先断开旧的
			if (jbAskMO) { try { jbAskMO.disconnect(); } catch (e) { /* 忽略 */ } }
			jbAskMO = askMo;
			askMo.observe(document.body, { childList: true, subtree: true });

			// 9b. 任务完成播报（v4 精准化）：只认「回合结束页脚」→ 播报任务完成
			// DSH 每个对话回合**真正结束**（turn/end）时，会**新插入**一个回合页脚
			// `[data-turn-tail]`，内含「用时 X秒 · 首 token X秒 · X tok/s」指标栏。
			// ⚠️ v3 误报根因：旧实现扫描页面上**任意**新增节点里的指标句式，而这些句式
			//   还会出现在：① 会话统计栏（输入框上方 StatsLine 的 "X tok/s"，任务第一步
			//   完成后就出现、任务还在跑）；② 后台任务卡片 title="耗时 X秒"（子任务完成）；
			//   ③ 子代理卡"总活跃耗时"；④ 轨迹面板 "TTFT / X tok/s"。
			//   → 任务没结束就播报。v4 只认 [data-turn-tail]（回合结束页脚），排除误报。
			let lastTaskDoneAt = 0;
			const TASK_DONE_COOLDOWN = 20000;  // 完成后 20 秒内不重复播报
			// 「加载更早」抑制（v5.2 修复）：点「加载更早/更多」翻历史 → 抑制窗口内新插入的页脚
			// 一律视为历史加载，不播任务完成。根因：历史增量加载常只有 1~2 个页脚（<批量保护阈值 3），
			// 躲过 v4 的批量重建保护，旧回合页脚被误判为新任务完成 → 误播。
			let historyLoadSuppressUntil = 0;
			const HISTORY_SUPPRESS_MS = 4000;   // 点「加载更早」后 4 秒内新页脚全部静音
			const HISTORY_LOAD_RE = /加载更早|加载更多|加载较早|查看更多|加载之前|Load earlier|Load more|Show more|load earlier|load more/i;
			document.addEventListener("click", (e) => {
				try {
					const t = e.target;
					const el = t && t.closest ? t.closest("button, [role='button'], [role='link'], a") : null;
					const text = ((el || t).textContent || "").trim();
					if (text && text.length <= 24 && HISTORY_LOAD_RE.test(text)) {
						historyLoadSuppressUntil = Date.now() + HISTORY_SUPPRESS_MS;
					}
				} catch (e2) { /* ignore */ }
			}, true);
			// 完整句式：固定词 + 数字 + 固定词（数字可变）
			const TASK_METRIC_RE = /(用时|耗时|消耗|共花费)\s*[0-9.]+(秒|s|分钟|分)|首\s?token\s*[0-9.]+(秒|s)|[0-9.]+\s*tok\/?s|[0-9.]+\s*tokens?\/s/i;
			/** 已播报过的回合页脚 turn id（同一回合不重复播；页面生命周期内保留）。 */
			const seenTurnTails = new Set();
			let pendingTurnTailCheck = null;   // 待验证的回合页脚（延迟判断是否批量重建）
			const BULK_THRESHOLD = 3;          // 0.6s 内出现 ≥3 个新页脚 = 历史批量重建（切会话）
			const BULK_VERIFY_MS = 600;        // 延迟验证窗口
			/** 从节点向上/向下定位「回合结束页脚」[data-turn-tail]，找不到返回 null。 */
			function findTurnTail(node) {
				try {
					if (!node || node.nodeType !== 1) return null;
					if (node.closest && node.closest("#jingbao-pet")) return null;  // 排除桌宠自身
					const up = node.closest ? node.closest("[data-turn-tail]") : null;
					if (up) return up;
					if (node.querySelectorAll) {
						const down = node.querySelector("[data-turn-tail]");
						if (down) return down;
					}
				} catch (e) { /* ignore */ }
				return null;
			}
			/** 回合页脚是否含任务结束指标句式（用时/首 token/tok/s）。 */
			function turnTailHasMetric(tt) {
				try {
					const t = (tt.textContent || "").trim();
					if (t && t.length <= 800 && TASK_METRIC_RE.test(t)) return true;
					if (tt.getAttribute) {
						const title = tt.getAttribute("title") || tt.getAttribute("aria-label") || "";
						if (title && title.length <= 200 && TASK_METRIC_RE.test(title)) return true;
					}
				} catch (e) { /* ignore */ }
				return false;
			}
			/** 处理一个回合页脚：判重 → 历史加载抑制 → 批量保护 → 播报。 */
			function handleTurnTail(tt) {
				if (!tt) return;
				let id = null;
				try { id = tt.getAttribute && tt.getAttribute("data-turn-tail"); } catch (e) { /* ignore */ }
				if (id === null || id === "") id = "?";
				if (seenTurnTails.has(id)) return;   // 同一回合不重复播
				// 「加载更早」抑制：翻历史加载的历史页脚一律静音（v5.2）
				if (Date.now() < historyLoadSuppressUntil) { seenTurnTails.add(id); return; }
				// 批量渲染保护（延迟验证法，与确认弹窗同思路）：
				// 新页脚出现后等 0.6s —— 若这段时间又冒出多个新页脚 = 切换会话/历史重建，
				// 全部标记已见不播；若只有它一个 = 真·新回合完成 → 播报
				if (pendingTurnTailCheck) { clearTimeout(pendingTurnTailCheck); pendingTurnTailCheck = null; }
				pendingTurnTailCheck = setTimeout(() => {
					pendingTurnTailCheck = null;
					const newIds = [];
					try {
						document.querySelectorAll("[data-turn-tail]").forEach((el) => {
							let eid = null;
							try { eid = el.getAttribute && el.getAttribute("data-turn-tail"); } catch (e2) { /* ignore */ }
							if (eid === null || eid === "") eid = "?";
							if (!seenTurnTails.has(eid)) newIds.push(eid);
						});
					} catch (e) { /* ignore */ }
					// 「加载更早」抑制（v5.2）：验证时刻处于抑制窗口 → 全部静音（点击加载历史时挂起的验证）
					if (Date.now() < historyLoadSuppressUntil) {
						newIds.forEach((eid) => seenTurnTails.add(eid));
						return;
					}
					if (newIds.length >= BULK_THRESHOLD) {
						// 历史批量重建（切换会话等）：全部标记已见，不播报
						newIds.forEach((eid) => seenTurnTails.add(eid));
						return;
					}
					// 正常：只播「最新的回合页脚」（含指标才播）
					try {
						const all = document.querySelectorAll("[data-turn-tail]");
						const last = all[all.length - 1];
						if (last && turnTailHasMetric(last)) announceTaskDone();
					} catch (e) { /* ignore */ }
					newIds.forEach((eid) => seenTurnTails.add(eid));
				}, BULK_VERIFY_MS);
			}
			// 回合结束页脚 MutationObserver（全局单例，apply 重入时先断开旧的）
			// 同时监听 childList（新增页脚）和 characterData（页脚文本填充）——
			// DSH 可能"先插入空页脚再填充指标文本"，两种都覆盖
			// ⚠️ 命名教训：局部 const 不能叫 jbDoneMO（模块级已有 let jbDoneMO）——
			//    函数作用域内 const 提升 + TDZ + 遮蔽，apply 开头访问 jbDoneMO 会抛
			//    "Cannot access before initialization" 拖垮插件 → 局部改名 jbDoneObserver
			const jbDoneObserver = new MutationObserver((muts) => {
				// 预热期：页面加载后 3 秒内不播报（等初始 DOM 稳定，避免把已有历史当新任务）
				if (Date.now() < jbDoneReadyAt) return;
				for (let i = 0; i < muts.length; i += 1) {
					const m = muts[i];
					// 1. 新增节点：可能是新回合页脚（或其祖先/后代）
					const added = m.addedNodes;
					for (let j = 0; j < added.length; j += 1) {
						const tt = findTurnTail(added[j]);
						if (tt) handleTurnTail(tt);
					}
					// 2. 文本更新（characterData）：页脚内部指标文本填充
					if (m.type === "characterData" && m.target && m.target.parentElement) {
						const tt = findTurnTail(m.target.parentElement);
						if (tt) handleTurnTail(tt);
					}
				}
			});
			// 触发一次任务完成播报（带 20s 冷却）
			function announceTaskDone() {
				const now = Date.now();
				if (now - lastTaskDoneAt >= TASK_DONE_COOLDOWN) {
					// 人性化：这一回合已经播过确认/提问语音（有弹窗提醒过主人了）→
					// 回合结束不再播任务完成语音，避免「改个代码响两次」的打扰；
					// 普通回合（没弹窗）任务完成播报照常。
					if (now - lastConfirmAt < 5000 || now - lastAskAt < 5000) return;
					lastTaskDoneAt = now;
					lastActivity = Date.now();  // 播报也算活跃，不打断瞌睡判定
					scheduleDoneAnnounce();
				}
			}
			if (window.__jbDoneMO) { try { window.__jbDoneMO.disconnect(); } catch (e) { /* 忽略 */ } }
			window.__jbDoneMO = jbDoneObserver;
			jbDoneMO = jbDoneObserver;   // 同步到模块级单例，供 apply 重入时（543 行）断开旧的，避免双观察器
			const jbDoneReadyAt = Date.now() + 3000;  // 3 秒预热期
			jbDoneObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
			// 任务完成播报：检测到回合页脚后播报（0.6s 延迟验证期已排除批量重建）
			function scheduleDoneAnnounce() {
				const dIdx = Math.floor(Math.random() * DONE_LINES.length);
				showBubble(DONE_LINES[dIdx], 4000);
				playVoiceIndex("done", dIdx);  // 语音与气泡同句
				// 对话后刷新：任务完成时同步刷新余额（主人能知道这次对话花了多少）
				if (monitor.balanceEnabled) fetchBalance();
			}
			// 测试钩子：模拟一次任务完成播报（主人验收用）
			window.__jbTestDone = () => {
				const dIdx = Math.floor(Math.random() * DONE_LINES.length);
				showBubble(DONE_LINES[dIdx], 4000);
				playVoiceIndex("done", dIdx);
			};
			// 调试钩子：列出页面上所有「回合页脚」及其指标匹配情况（v4 排查用）
			window.__jbTaskScan = () => {
				const hits = [];
				try {
					document.querySelectorAll("[data-turn-tail]").forEach((el) => {
						const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
						hits.push({
							turn: (el.getAttribute && el.getAttribute("data-turn-tail")) || "?",
							metric: TASK_METRIC_RE.test(t),
							text: t,
							cls: (el.className || "").toString().slice(0, 40)
						});
					});
				} catch (e) { /* ignore */ }
				return { count: hits.length, hits };
			};

			// 10. 待机随机卖萌（瞌睡时冒 zzz，正常时冒卖萌语）
			function scheduleIdle(delay) {
				const d = delay !== undefined ? delay : IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
				idleTimer = setTimeout(() => {
					if (idlePaused) return;  // 暂停中：等 resumeIdleTimer 重新调度
					if (Date.now() < idleBlockedUntil) {
						// 点击后 5 秒冷却期：不触发随机动画/卖萌，重新调度
						scheduleIdle();
						return;
					}
					if (animTimer) {
						// 当前有动画（微笑/眨眼/挥手等）正在播放：不顶替，顺延到下一轮
						scheduleIdle();
						return;
					}
					if (sleepyFlag) {
						showBubble(pick(ZZZ_LINES), 2500);
					} else {
						const r = Math.random();
						if (r < 0.3) {
							// 30% 概率播「微笑合十」动画
							playAnim("smile", 3600);
							showBubble(pick(SMILE_LINES), 3600);
						} else if (r < 0.55) {
							// 25% 概率播「眨眼」动画（3 秒）
							playAnim("blink", 3000);
						} else {
							showBubble(pick(IDLE_LINES), 3000);
						}
					}
					scheduleIdle();
				}, d);
			}
			scheduleIdle();
			// 节日/特殊日期祝福（页面加载后 3 秒冒一次）
			const holidayLine = holidayGreeting();
			if (holidayLine) setTimeout(() => showBubble(holidayLine, 5000), 3000);
		}

		exports.inject = [];
		exports.apply = apply;
		return module.exports;
	}
});
