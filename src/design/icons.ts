// src/design/icons.ts — the only place Font Awesome class names exist (Part I §10.3).
//
// Semantic names are dotted (group.name); values are transcribed ONCE from Appendix F §2.6.
// Templates write `<i class="sl-icon" data-icon="action.play"></i>`; `panel/icons-mount.ts`
// resolves the name to these classes (always with `fa-fw`), and `scripts/gen-icons.ts` verifies
// every `fa-*` glyph exists in the vendored `assets/vendor/fontawesome/css/all.min.css`.
export const ICONS = {
	"nav.game": "fa-solid fa-chess-knight",
	"nav.settings": "fa-solid fa-sliders",
	"nav.engine": "fa-solid fa-wave-square",
	"status.idle": "fa-regular fa-circle",
	"status.thinking": "fa-solid fa-circle-notch", // rendered with `fa-spin`; static under reduced motion
	"status.ok": "fa-solid fa-circle-check",
	"status.attached": "fa-solid fa-plug-circle-check",
	"status.detached": "fa-solid fa-plug-circle-xmark",
	"status.offline": "fa-solid fa-plug-circle-minus",
	"action.play": "fa-solid fa-play",
	"action.cancel": "fa-solid fa-xmark",
	"action.close": "fa-solid fa-xmark",
	"action.back": "fa-solid fa-arrow-left",
	"action.speak": "fa-solid fa-volume-high",
	"action.mute": "fa-solid fa-volume-xmark",
	"action.edit": "fa-solid fa-pen",
	"action.copy": "fa-regular fa-copy",
	"action.export": "fa-solid fa-download",
	"action.refresh": "fa-solid fa-rotate-right",
	"action.logout": "fa-solid fa-arrow-right-from-bracket",
	"action.external": "fa-solid fa-arrow-up-right-from-square",
	"action.chevronDown": "fa-solid fa-chevron-down",
	"action.chevronRight": "fa-solid fa-chevron-right",
	"action.reveal": "fa-regular fa-eye",
	"action.hide": "fa-regular fa-eye-slash",
	"action.reattach": "fa-solid fa-plug",
	"action.update": "fa-solid fa-cloud-arrow-down",
	"feedback.info": "fa-solid fa-circle-info",
	"feedback.warning": "fa-solid fa-triangle-exclamation",
	"feedback.danger": "fa-solid fa-circle-exclamation",
	"feedback.success": "fa-solid fa-circle-check",
	"feedback.locked": "fa-solid fa-lock",
	"feedback.hourglass": "fa-regular fa-hourglass-half",
	"toggle.autoplay": "fa-solid fa-bolt",
	"toggle.highlight": "fa-solid fa-highlighter",
	"toggle.autoqueue": "fa-solid fa-forward-step",
	"toggle.sound": "fa-solid fa-volume-high",
	"toggle.tts": "fa-solid fa-comment",
	"game.clock": "fa-regular fa-clock",
	"game.turn": "fa-solid fa-caret-left",
	"game.eval": "fa-solid fa-scale-balanced",
	"game.arrow": "fa-solid fa-arrow-right-long",
	"game.board": "fa-solid fa-chess-board",
	"game.keyboard": "fa-regular fa-keyboard",
	"persona.cautious": "fa-solid fa-shield-halved",
	"persona.balanced": "fa-solid fa-scale-balanced",
	"persona.aggressive": "fa-solid fa-fire",
	"persona.blitz": "fa-solid fa-bolt-lightning",
	"exec.drag": "fa-solid fa-hand",
	"exec.click": "fa-solid fa-arrow-pointer",
	"engine.threads": "fa-solid fa-microchip",
	"engine.memory": "fa-solid fa-memory",
	"engine.nnue": "fa-solid fa-brain",
	"engine.log": "fa-solid fa-scroll",
	"engine.timing": "fa-solid fa-stopwatch",
	"account.key": "fa-solid fa-key",
	"account.device": "fa-solid fa-laptop",
	"account.user": "fa-regular fa-user",
	"social.discord": "fa-brands fa-discord",
	"social.globe": "fa-solid fa-globe",
} as const;

export type IconName = keyof typeof ICONS;

/** Font Awesome style/utility classes that are not glyph names (Appendix F §2.6 rules). */
export const ICON_STYLE_CLASSES = [
	"fa-solid",
	"fa-regular",
	"fa-brands",
	"fa-fw",
	"fa-spin",
] as const;
