import { StyleSheet, View } from "react-native";

export function MiniBoardChatPreviewSkeleton() {
  return (
    <View style={miniBoardChatPreviewSkeletonStyles.root}>
      <View style={miniBoardChatPreviewSkeletonStyles.header}>
        <View style={miniBoardChatPreviewSkeletonStyles.avatar} />
        <View style={miniBoardChatPreviewSkeletonStyles.title} />
      </View>
      <View style={miniBoardChatPreviewSkeletonStyles.bubbleWide} />
      <View style={miniBoardChatPreviewSkeletonStyles.bubble} />
      <View style={miniBoardChatPreviewSkeletonStyles.bubbleShort} />
    </View>
  );
}

const miniBoardChatPreviewSkeletonStyles = StyleSheet.create({
  root: {
    flex: 1,
    gap: 10,
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },
  avatar: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: "rgba(21, 21, 17, 0.10)",
  },
  title: {
    width: "46%",
    height: 9,
    borderRadius: 999,
    backgroundColor: "rgba(21, 21, 17, 0.10)",
  },
  bubbleWide: {
    width: "86%",
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(21, 21, 17, 0.08)",
  },
  bubble: {
    width: "70%",
    height: 18,
    borderRadius: 9,
    alignSelf: "flex-end",
    backgroundColor: "rgba(21, 21, 17, 0.08)",
  },
  bubbleShort: {
    width: "52%",
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(21, 21, 17, 0.08)",
  },
});
