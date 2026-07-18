import "react-native-gesture-handler";
import { registerRootComponent } from 'expo';
import { bootstrapLocationSchedules } from "./src/features/locationSchedules/locationScheduleRuntime";

import App from './App';

void bootstrapLocationSchedules();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
