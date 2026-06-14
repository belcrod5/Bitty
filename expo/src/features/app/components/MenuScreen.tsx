import { ScrollView, Text, TouchableOpacity, View, type StyleProp, type ViewStyle, type TextStyle } from "react-native";

type MenuScreenProps = {
  containerStyle: StyleProp<ViewStyle>;
  debugHeaderRowStyle: StyleProp<ViewStyle>;
  debugBackButtonStyle: StyleProp<ViewStyle>;
  debugBackButtonTextStyle: StyleProp<TextStyle>;
  titleStyle: StyleProp<TextStyle>;
  menuNavButtonStyle: StyleProp<ViewStyle>;
  menuNavTitleStyle: StyleProp<TextStyle>;
  menuNavValueStyle: StyleProp<TextStyle>;
  hintStyle: StyleProp<TextStyle>;
  selectedModelLabel: string;
  selectedLlmSessionLabel: string;
  llmDirectoryLabel: string;
  onBackToChat: () => void;
  onOpenModelSelect: () => void;
  onOpenDirectoryExplorer: () => void;
  onOpenSessionHistory: () => void;
  onOpenDebug: () => void;
};

export function MenuScreen({
  containerStyle,
  debugHeaderRowStyle,
  debugBackButtonStyle,
  debugBackButtonTextStyle,
  titleStyle,
  menuNavButtonStyle,
  menuNavTitleStyle,
  menuNavValueStyle,
  hintStyle,
  selectedModelLabel,
  selectedLlmSessionLabel,
  llmDirectoryLabel,
  onBackToChat,
  onOpenModelSelect,
  onOpenDirectoryExplorer,
  onOpenSessionHistory,
  onOpenDebug,
}: MenuScreenProps) {
  return (
    <ScrollView contentContainerStyle={containerStyle}>
      <Text style={titleStyle}>LLM Menu</Text>
      <View style={debugHeaderRowStyle}>
        <TouchableOpacity style={debugBackButtonStyle} onPress={onBackToChat}>
          <Text style={debugBackButtonTextStyle}>← Chat</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={menuNavButtonStyle} onPress={onOpenModelSelect}>
        <Text style={menuNavTitleStyle}>LLM Model</Text>
        <Text style={menuNavValueStyle}>{selectedModelLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={menuNavButtonStyle} onPress={onOpenDirectoryExplorer}>
        <Text style={menuNavTitleStyle}>Directory Explorer</Text>
        <Text style={menuNavValueStyle}>{llmDirectoryLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={menuNavButtonStyle} onPress={onOpenSessionHistory}>
        <Text style={menuNavTitleStyle}>Session History</Text>
        <Text style={menuNavValueStyle}>{selectedLlmSessionLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={menuNavButtonStyle} onPress={onOpenDebug}>
        <Text style={menuNavTitleStyle}>Current Settings</Text>
        <Text style={menuNavValueStyle}>Debug設定画面を開く</Text>
      </TouchableOpacity>
      <Text style={hintStyle}>Directory: {llmDirectoryLabel} / Session: {selectedLlmSessionLabel}</Text>
    </ScrollView>
  );
}
