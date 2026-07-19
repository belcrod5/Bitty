import { useEffect, useState } from "react";
import {
  Modal,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Circle, Marker, type Region } from "react-native-maps";
import * as Location from "expo-location";

export type LocationMapPickerTarget = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

type Props = {
  target: LocationMapPickerTarget | null;
  onCancel: () => void;
  onConfirm: (coordinate: { latitude: number; longitude: number }) => void;
};

const FALLBACK_REGION: Region = {
  latitude: 35.681236,
  longitude: 139.767125,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

function regionForCoordinate(latitude: number, longitude: number, radiusMeters: number): Region {
  // 半径円が収まる程度のズーム（1度 ≒ 111km）
  const delta = Math.max((Number.isFinite(radiusMeters) ? radiusMeters : 0) * 4 / 111_000, 0.005);
  return { latitude, longitude, latitudeDelta: delta, longitudeDelta: delta };
}

export function LocationMapPicker({ target, onCancel, onConfirm }: Props) {
  const [coordinate, setCoordinate] = useState<{ latitude: number; longitude: number } | null>(null);
  const [initialRegion, setInitialRegion] = useState<Region | null>(null);

  useEffect(() => {
    setCoordinate(null);
    setInitialRegion(null);
    if (!target) return;
    let cancelled = false;
    if (Number.isFinite(target.latitude) && Number.isFinite(target.longitude)) {
      setCoordinate({ latitude: target.latitude, longitude: target.longitude });
      setInitialRegion(regionForCoordinate(target.latitude, target.longitude, target.radiusMeters));
      return;
    }
    (async () => {
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== "granted") permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") throw new Error("permission denied");
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        setInitialRegion(regionForCoordinate(
          position.coords.latitude,
          position.coords.longitude,
          target.radiusMeters
        ));
      } catch {
        if (!cancelled) setInitialRegion(FALLBACK_REGION);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  const radiusMeters = Number.isFinite(target?.radiusMeters) ? Number(target?.radiusMeters) : 0;

  return (
    <Modal visible={target !== null} animationType="slide" onRequestClose={onCancel}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel}>
            <Text style={styles.headerAction}>キャンセル</Text>
          </TouchableOpacity>
          <Text style={styles.title}>マップで位置を選択</Text>
          <TouchableOpacity
            onPress={() => coordinate && onConfirm(coordinate)}
            disabled={!coordinate}
          >
            <Text style={[styles.headerAction, !coordinate && styles.disabled]}>決定</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.help}>タップした場所にピンを置きます。円はジオフェンスの半径です。</Text>
        {initialRegion ? (
          <MapView
            style={styles.map}
            initialRegion={initialRegion}
            showsUserLocation
            onPress={(event) => setCoordinate(event.nativeEvent.coordinate)}
          >
            {coordinate ? <Marker coordinate={coordinate} /> : null}
            {coordinate && radiusMeters > 0 ? (
              <Circle
                center={coordinate}
                radius={radiusMeters}
                strokeColor="rgba(15, 118, 110, 0.9)"
                fillColor="rgba(15, 118, 110, 0.15)"
              />
            ) : null}
          </MapView>
        ) : (
          <View style={styles.map} />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },
  header: { height: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#cbd5e1", backgroundColor: "#fff" },
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
  headerAction: { fontSize: 16, color: "#2563eb", minWidth: 64 },
  disabled: { opacity: 0.4 },
  help: { paddingHorizontal: 16, paddingVertical: 8, color: "#475569", fontSize: 12 },
  map: { flex: 1 },
});
