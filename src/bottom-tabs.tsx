import * as React from 'react';
import {
  createNavigatorFactory,
  useNavigationBuilder,
  type DefaultNavigatorOptions,
  type Descriptor,
  type ParamListBase,
  type TabNavigationState,
} from '@react-navigation/core';
import { TabActions, TabRouter, type TabRouterOptions } from '@react-navigation/routers';
import { BackHandler, Text, View, useSafeAreaInsets, useTheme } from '@rayact/react';

type TabNavigationOptions = {
  tabBarLabel?: string;
  /** Mount on first focus; keep mounted after. Default true. */
  lazy?: boolean;
};

type TabBarProps = {
  state: TabNavigationState<ParamListBase>;
  descriptors: Record<string, DescriptorWithKey>;
  navigation: { navigate: (name: string) => void };
};

type Props = DefaultNavigatorOptions<
  ParamListBase,
  string | undefined,
  TabNavigationState<ParamListBase>,
  TabNavigationOptions,
  Record<string, never>,
  unknown
> &
  TabRouterOptions & {
    tabBarPosition?: 'bottom' | 'top';
    tabBarExtendPaddingToSafeArea?: boolean;
    tabBar?: (props: TabBarProps) => React.ReactNode;
  };

type DescriptorWithKey = Descriptor<TabNavigationOptions, any, any>;

const fill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

function DefaultTabBar({
  state,
  descriptors,
  navigation,
  position,
  extendPaddingToSafeArea,
}: {
  state: TabNavigationState<ParamListBase>;
  descriptors: Record<string, DescriptorWithKey>;
  navigation: { navigate: (name: string) => void };
  position: 'bottom' | 'top';
  extendPaddingToSafeArea: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const inset = extendPaddingToSafeArea
    ? Math.max(0, position === 'top' ? insets.top : insets.bottom)
    : 0;
  const row = (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: theme.surfaceContainerHigh,
        borderTopWidth: position === 'bottom' ? 1 : 0,
        borderTopColor: theme.outlineVariant,
        borderBottomWidth: position === 'top' ? 1 : 0,
        borderBottomColor: theme.outlineVariant,
      }}
    >
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const descriptor = descriptors[route.key];
        const label = descriptor.options.tabBarLabel ?? route.name;
        const onPress = () => navigation.navigate(route.name);
        return (
          <View
            key={route.key}
            onPress={onPress}
            style={{
              flex: 1,
              paddingVertical: 14,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: focused ? theme.primaryContainer : 'transparent',
            }}
          >
            <Text
              text={typeof label === 'string' ? label : route.name}
              style={{ color: focused ? theme.onPrimaryContainer : theme.onSurfaceVariant, fontSize: 14 }}
            />
          </View>
        );
      })}
    </View>
  );
  if (inset <= 0) return row;
  return (
    <View style={{ backgroundColor: theme.surfaceContainerHigh }}>
      {position === 'top' ? (
        <View pointerEvents="none" style={{ height: inset, backgroundColor: theme.surfaceContainerHigh }} />
      ) : null}
      {row}
      {position === 'bottom' ? (
        <View pointerEvents="none" style={{ height: inset, backgroundColor: theme.surfaceContainerHigh }} />
      ) : null}
    </View>
  );
}

function BottomTabsNavigator({
  id,
  initialRouteName,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  tabBarPosition = 'bottom',
  tabBarExtendPaddingToSafeArea = false,
  ...rest
}: Props) {
  const { state, descriptors, navigation, NavigationContent } =
    useNavigationBuilder<TabNavigationState<ParamListBase>, TabRouterOptions, any, TabNavigationOptions, Record<string, never>>(
      TabRouter,
      {
        id,
        initialRouteName,
        children,
        layout,
        screenListeners,
        screenOptions,
        screenLayout,
        ...rest,
      },
    );

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (state.history.length > 1) {
        navigation.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [navigation, state.history.length]);

  const mountedTabsRef = React.useRef<Set<string>>(
    new Set(initialRouteName ? [initialRouteName] : []),
  );

  React.useLayoutEffect(() => {
    const name = state.routes[state.index]?.name;
    if (name) mountedTabsRef.current.add(name);
  }, [state.index, state.routes]);

  return (
    <NavigationContent>
      <View style={{ flex: 1 }}>
        {tabBarPosition === 'top' ? (
          <DefaultTabBar
            state={state}
            descriptors={descriptors as Record<string, DescriptorWithKey>}
            navigation={navigation}
            position={tabBarPosition}
            extendPaddingToSafeArea={tabBarExtendPaddingToSafeArea}
          />
        ) : null}
        <View style={{ flex: 1 }}>
          {state.routes.map((route, index) => {
            const descriptor = descriptors[route.key] as DescriptorWithKey;
            const lazy = descriptor.options.lazy !== false;
            if (lazy && !mountedTabsRef.current.has(route.name)) return null;
            return (
              <View
                key={route.key}
                style={[
                  fill,
                  index === state.index
                    ? null
                    : { opacity: 0, pointerEvents: 'none' as const },
                ]}
              >
                {descriptor.render()}
              </View>
            );
          })}
        </View>
        {tabBarPosition === 'bottom' ? (
          <DefaultTabBar
            state={state}
            descriptors={descriptors as Record<string, DescriptorWithKey>}
            navigation={navigation}
            position={tabBarPosition}
            extendPaddingToSafeArea={tabBarExtendPaddingToSafeArea}
          />
        ) : null}
      </View>
    </NavigationContent>
  );
}

export const createBottomTabNavigator = createNavigatorFactory(BottomTabsNavigator);
export const createMaterialTopTabNavigator = createBottomTabNavigator;
export { TabActions };
