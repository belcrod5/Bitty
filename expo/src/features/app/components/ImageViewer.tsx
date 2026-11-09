import { useState } from "react";
import { Image, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View, type ImageURISource } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { GestureViewer } from "react-native-gesture-image-viewer";
import { AppModal } from "./AppModal";

type ImageViewerProps = {
  source: ImageURISource;
  onRequestClose: () => void;
};

export function ImageViewer({ source, onRequestClose }: ImageViewerProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState(false);
  return (
    <AppModal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onRequestClose}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaView style={styles.root}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="画像ビューアーを閉じる"
            onPress={onRequestClose} style={styles.close}>
            <Text style={styles.closeText}>閉じる</Text>
          </TouchableOpacity>
          <View style={styles.content} testID="image-viewer-content" onLayout={({ nativeEvent: { layout } }) => {
            setSize(previous => previous.width === layout.width && previous.height === layout.height
              ? previous : { width: layout.width, height: layout.height });
          }}>
            {size.width > 0 && size.height > 0 ? (
              <GestureViewer data={[source]} width={size.width} height={size.height}
                ListComponent={ScrollView} maxZoomScale={6} enablePinchZoom enableDoubleTapZoom enablePanWhenZoomed
                dismiss={{ enabled: false }}
                renderItem={item => <Image source={item} style={styles.image} resizeMode="contain"
                  accessibilityLabel="拡大画像" onError={() => setError(true)} />} />
            ) : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>画像を表示できませんでした。</Text> : null}
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  content: { flex: 1 },
  image: { width: "100%", height: "100%" },
  close: { alignSelf: "flex-end", paddingHorizontal: 20, paddingVertical: 14 },
  closeText: { color: "#fff", fontSize: 16 },
  error: { position: "absolute", bottom: 20, alignSelf: "center", color: "#fff" },
});
