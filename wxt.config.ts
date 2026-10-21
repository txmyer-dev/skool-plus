import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'skool+',
    description: 'Draft replies in your own voice on Skool, and post to any community from anywhere on the web.',
    permissions: ['sidePanel', 'storage', 'unlimitedStorage', 'contextMenus', 'activeTab', 'scripting', 'tabs'],
    host_permissions: ['https://*.skool.com/*', 'https://api.anthropic.com/*', 'http://127.0.0.1/*', 'http://localhost/*'],
    side_panel: { default_path: 'sidepanel.html' },
    action: { default_title: 'skool+' },
    commands: {
      'capture-to-skool': {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Send the current selection to skool+',
      },
    },
  },
});
