/**
 * Status screen for the Supersidian autosave plugin.
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {ensureWritePermission, permissionsGranted, saveNow, status, watch} from './autosave';
import {uplinkStatus} from './uplink';

function time(t: number | null): string {
  if (!t) return 'never';
  return new Date(t).toLocaleTimeString();
}

function Button({label, onPress}: {label: string; onPress: () => void}) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function App(): React.JSX.Element {
  const [, setTick] = useState(0);
  const [permission, setPermission] = useState<number | null>(null);
  const refresh = () => setTick(n => n + 1);

  useEffect(() => {
    permissionsGranted().then(setPermission);
    return watch(refresh);
  }, []);

  const allow = async () => {
    await ensureWritePermission();
    setPermission(await permissionsGranted());
  };

  return (
    <View style={styles.container}>
      <Pressable style={styles.close} onPress={() => PluginManager.closePluginView()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
      <Text style={styles.title}>Supersidian</Text>
      <Text style={styles.line}>
        Sends your strokes to Obsidian as you write, and saves the notebook when you move to another page or erase. Without the cable, both go to the laptop over Tailscale.
      </Text>
      <Text style={styles.line}>File and network access: {permission === 1 ? 'allowed' : 'not allowed'}</Text>
      <Text style={styles.line}>Pen lifts seen: {status.penUps} ({status.penUpsHidden} while this screen was closed)</Text>
      <Text style={styles.line}>Saves: {status.saves} (last {time(status.lastSave)})</Text>
      {status.lastFile ? <Text style={styles.line}>File: {status.lastFile}</Text> : null}
      {status.lastError ? <Text style={styles.line}>Last error: {status.lastError}</Text> : null}
      <Text style={styles.line}>Live strokes sent: {status.liveSent}</Text>
      {status.liveError ? <Text style={styles.line}>Live error: {status.liveError}</Text> : null}
      <Text style={styles.line}>
        Tailscale sync: {uplinkStatus.configured ? (uplinkStatus.usb ? 'paused, USB is in' : `on, ${uplinkStatus.sent} live messages, last upload ${time(uplinkStatus.lastUpload)}`) : 'not set up (connect the cable once)'}
      </Text>
      {uplinkStatus.lastError ? <Text style={styles.line}>Tailscale error: {uplinkStatus.lastError}</Text> : null}
      <View style={styles.row}>
        {permission === 1 ? null : <Button label="Allow access" onPress={allow} />}
        <Button label="Save now" onPress={saveNow} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: 48, backgroundColor: '#ffffff'},
  close: {position: 'absolute', top: 12, right: 12, padding: 12},
  closeText: {fontSize: 28, color: '#000000'},
  title: {fontSize: 36, fontWeight: '700', color: '#000000', marginBottom: 24},
  line: {fontSize: 24, color: '#000000', marginBottom: 12},
  row: {flexDirection: 'row', marginTop: 24},
  button: {borderWidth: 2, borderColor: '#000000', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 20, marginRight: 16},
  buttonText: {fontSize: 24, color: '#000000'},
});

export default App;
