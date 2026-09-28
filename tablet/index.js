/**
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {startAutosave} from './autosave';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// Toolbar button in NOTE that opens the status screen.
PluginManager.registerButton(1, ['NOTE'], {
  id: 100,
  name: 'Supersidian',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

startAutosave();
