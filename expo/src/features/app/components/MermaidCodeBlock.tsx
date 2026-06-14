import { useState } from "react";
import {
  Modal,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { MermaidView } from "./MermaidView";

type MermaidCodeBlockProps = {
  chart: string;
  codeBlockStyle: NonNullable<MarkdownStyle["codeBlock"]>;
};

export function MermaidCodeBlock({ chart, codeBlockStyle }: MermaidCodeBlockProps) {
  const [modalVisible, setModalVisible] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const canRender = chart.trim().length > 0;
  const previewHeight = Math.max(260, windowHeight - 132);

  const blockViewStyle: ViewStyle = {
    backgroundColor: codeBlockStyle.backgroundColor,
    borderColor: codeBlockStyle.borderColor,
    borderRadius: codeBlockStyle.borderRadius,
    borderWidth: codeBlockStyle.borderWidth,
    padding: codeBlockStyle.padding,
  };
  const blockTextStyle: TextStyle = {
    color: codeBlockStyle.color,
    fontFamily: codeBlockStyle.fontFamily,
    fontSize: codeBlockStyle.fontSize,
    fontWeight: codeBlockStyle.fontWeight as TextStyle["fontWeight"],
    lineHeight: codeBlockStyle.lineHeight,
  };

  return (
    <View style={mermaidCodeStyles.wrap}>
      <View style={[mermaidCodeStyles.codeBlock, blockViewStyle]}>
        <TouchableOpacity
          style={[mermaidCodeStyles.renderButton, !canRender && mermaidCodeStyles.renderButtonDisabled]}
          onPress={() => setModalVisible(true)}
          disabled={!canRender}
          activeOpacity={0.85}
          accessibilityLabel="Mermaid preview open"
        >
          <Ionicons name="play" size={13} color="#0f172a" />
        </TouchableOpacity>
        <Text selectable style={[mermaidCodeStyles.codeText, blockTextStyle]}>
          {chart}
        </Text>
      </View>
      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setModalVisible(false)}
      >
        <SafeAreaView style={mermaidCodeStyles.modalSafeArea}>
          <View style={mermaidCodeStyles.modalContent}>
            <View style={mermaidCodeStyles.modalBody}>
              <MermaidView chart={chart} height={previewHeight} />
            </View>
            <TouchableOpacity
              style={mermaidCodeStyles.modalCloseButton}
              onPress={() => setModalVisible(false)}
              activeOpacity={0.85}
              accessibilityLabel="Mermaid preview close"
            >
              <Ionicons name="close" size={18} color="#0f172a" />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const mermaidCodeStyles = StyleSheet.create({
  wrap: {
    gap: 6,
    minWidth: 0,
  },
  codeBlock: {
    position: "relative",
    minWidth: 0,
  },
  codeText: {
    paddingRight: 34,
  },
  renderButton: {
    position: "absolute",
    top: 6,
    right: 6,
    zIndex: 1,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  renderButtonDisabled: {
    opacity: 0.45,
  },
  modalSafeArea: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  modalContent: {
    flex: 1,
    position: "relative",
  },
  modalCloseButton: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 2,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  modalBody: {
    flex: 1,
    padding: 8,
  },
});
