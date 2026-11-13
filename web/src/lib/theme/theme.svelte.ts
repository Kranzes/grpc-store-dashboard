// Theme choice for this tab only. Never persisted: the dashboard keeps
// nothing across visits.

export type ThemeMode = 'system' | 'light' | 'dark';

class Theme {
	mode = $state<ThemeMode>('system');

	set(mode: ThemeMode) {
		this.mode = mode;
		if (typeof document === 'undefined') return;
		// catppuccin.css follows the system preference unless data-theme is set.
		if (mode === 'system') delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = mode;
	}
}

export const theme = new Theme();
