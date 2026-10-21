import type { ReactNode } from "react";
import { Keyboard, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useVisualTheme } from "../theme/VisualThemeContext";
import { KeyboardAwareScrollView, KeyboardAvoidingView } from "../keyboardController";
import { AppModal } from "./AppModal";

export function LearningDetailsModal({ visible, title, subtitle, page, testID, onClose, children }: {
  visible: boolean; title: string; subtitle: string; page: number; testID: string; onClose: () => void; children: ReactNode;
}) {
  const { theme: { colors } } = useVisualTheme();
  const close = () => { Keyboard.dismiss(); onClose(); };
  return <AppModal visible={visible} animationType="slide" presentationStyle="fullScreen" backdropColor={colors.canvas}
    onRequestClose={close} testID={testID}>
    <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.screen, { backgroundColor: colors.canvas }]}>
      <View style={[styles.header, { borderColor: colors.borderSubtle }]}>
        <View style={styles.heading}><Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`${title}を閉じる`} onPress={close} style={styles.close}>
          <Text style={[styles.closeText, { color: colors.accent }]}>閉じる</Text></Pressable>
      </View>
      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === "ios" ? "padding" : undefined} automaticOffset={Platform.OS === "ios"}>
        <KeyboardAwareScrollView key={page} testID={`${testID}-scroll`} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          {children}
        </KeyboardAwareScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </AppModal>;
}
const styles = StyleSheet.create({
  screen: { flex: 1 }, body: { flex: 1, minHeight: 0 }, header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  heading: { flex: 1, minWidth: 0, gap: 5 }, title: { fontSize: 20, fontWeight: "700" }, subtitle: { fontSize: 12, lineHeight: 18 },
  close: { flexShrink: 0, minWidth: 56, minHeight: 44, alignItems: "center", justifyContent: "center" }, closeText: { fontSize: 14, fontWeight: "600" }, content: { padding: 20, paddingBottom: 36, gap: 14 },
});
