import { useEffect, useRef, useState } from "react";
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
import { useVisualTheme } from "../app/theme/VisualThemeContext";
import { createStylesByTheme, type VisualTheme } from "../app/theme/visualThemes";

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
  const { theme, themeId } = useVisualTheme();
  const styles = stylesByTheme[themeId];
  const [coordinate, setCoordinate] = useState<{ latitude: number; longitude: number } | null>(null);
  const [initialRegion, setInitialRegion] = useState<Region | null>(null);
  const openedRef = useRef(false);

  useEffect(() => {
    if (!target) {
      openedRef.current = false;
      setCoordinate(null);
      setInitialRegion(null);
      return;
    }
    // 開いている間の親の再レンダー(targetの参照変化)では初期化しない。
    // タップ済みのピンをリセットしないための必須ガード
    if (openedRef.current) return;
    openedRef.current = true;
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
                strokeColor={theme.colors.primaryAction}
                fillColor={theme.colors.primaryActionMuted}
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

function createStyles(theme: VisualTheme) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.surfaceRaised },
  header: { height: 52, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: theme.borders.thin, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface },
  title: { ...theme.typography.subtitleDense, fontWeight: "700", color: theme.colors.textPrimary },
  headerAction: { ...theme.typography.control, color: theme.colors.accent, minWidth: 64 },
  disabled: { opacity: 0.4 },
  help: { paddingHorizontal: 16, paddingVertical: 8, color: theme.colors.textSecondary, ...theme.typography.small },
  map: { flex: 1 },
  });
}

const stylesByTheme = createStylesByTheme(createStyles);
