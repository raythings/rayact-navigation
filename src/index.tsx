// @rayact/navigation
//
// React Navigation owns routing/state. Rayact owns the view layer.
// This stack intentionally renders screens as ordinary Rayact <View>s in one
// React tree on every platform. It does not allocate Android fragments,
// secondary React roots, or per-route native surfaces.

import * as React from 'react';
import {
  BaseNavigationContainer,
  createNavigatorFactory,
  useNavigationBuilder,
  type DefaultNavigatorOptions,
  type ParamListBase,
  type StackNavigationState,
  type Descriptor,
} from '@react-navigation/core';
import {
  StackRouter,
  type StackRouterOptions,
  type StackActionHelpers,
} from '@react-navigation/routers';
import {
  View,
  BackHandler,
  useTheme,
  easeInOutCubic,
} from '@rayact/react';

function perfEnabled(): boolean {
  return (globalThis as { __RAYACT_PERF_LOG?: boolean }).__RAYACT_PERF_LOG === true;
}

function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function perfLog(event: string, data?: Record<string, unknown>): void {
  if (!perfEnabled()) return;
  console.log(`[rayact:perf] ${event}`, { ...data, ts: perfNow() });
}

declare function getRenderWidth(): number;
declare function getRenderHeight(): number;
declare function getRenderScale(): number;
declare function getLogicalRenderWidth(): number;
declare function getLogicalRenderHeight(): number;

export type StackAnimation =
  | 'slide_from_right'
  | 'fade'
  | 'slide_from_bottom'
  | 'scale'
  | 'none';

export type RayactStackNavigationOptions = {
  /** Hide inactive screen content once another route is above it. */
  detachInactiveScreens?: boolean;
  /** Defer mounting screen content until after the transition shell is visible. */
  deferInitialRender?: boolean;
  /** Keep this route's content mounted while a route above it is entering. */
  keepPreviousRouteMounted?: boolean;
  /** Defer first content mount until after paint (default: true for animation 'none'). */
  lazy?: boolean;
  /** Keep this screen mounted by route name across replace/navigate (tab-style). */
  cacheByName?: boolean;
  /** Default 'slide_from_right'. */
  animation?: StackAnimation;
  /** Default 280ms. */
  animationDuration?: number;
};

type StackNavigationConfig = {
  animation?: StackAnimation;
  animationDuration?: number;
  /** Keep visited screens mounted by route name (instant tab-style switching). */
  cacheScreensByName?: boolean;
  /** Defer first mount of screen content until after paint. Default true. */
  lazyScreens?: boolean;
};

type Props = DefaultNavigatorOptions<
  ParamListBase,
  string | undefined,
  StackNavigationState<ParamListBase>,
  RayactStackNavigationOptions,
  Record<string, never>,
  unknown
> &
  StackRouterOptions &
  StackNavigationConfig;

type Style = Record<string, unknown>;
type LayoutSize = { width: number; height: number };
type Interpolator = (progress: number, layout: LayoutSize) => Style;

const slideFromRight: Interpolator = (p, l) => ({
  transform: [{ translateX: (1 - p) * l.width }],
});

const slideFromBottom: Interpolator = (p, l) => ({
  transform: [{ translateY: (1 - p) * l.height }],
});

const fade: Interpolator = (p) => ({ opacity: p });

const scale: Interpolator = (p) => ({
  transform: [{ scale: 0.9 + 0.1 * p }],
  opacity: p,
});

const noneInterpolator: Interpolator = () => ({});

const interpolators: Record<StackAnimation, Interpolator> = {
  slide_from_right: slideFromRight,
  slide_from_bottom: slideFromBottom,
  fade,
  scale,
  none: noneInterpolator,
};

const fill = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

type DescriptorWithKey = Descriptor<
  RayactStackNavigationOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

type RouteSnapshot = {
  key: string;
  descriptor: DescriptorWithKey;
};

function renderSize(): LayoutSize {
  const logicalWidth =
    typeof getLogicalRenderWidth === 'function'
      ? getLogicalRenderWidth()
      : 0;
  const logicalHeight =
    typeof getLogicalRenderHeight === 'function'
      ? getLogicalRenderHeight()
      : 0;
  if (logicalWidth > 0 && logicalHeight > 0) {
    return { width: logicalWidth, height: logicalHeight };
  }

  const scale =
    typeof getRenderScale === 'function' && getRenderScale() > 0
      ? getRenderScale()
      : 1;
  const width =
    typeof getRenderWidth === 'function' ? getRenderWidth() / scale : 0;
  const height =
    typeof getRenderHeight === 'function' ? getRenderHeight() / scale : 0;
  return { width, height };
}

function animatedStyleFrom(style: Style): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof style.opacity === 'number') out.opacity = style.opacity;
  if (typeof style.scale === 'number') out.scale = style.scale;
  if (typeof style.translateX === 'number') out.translateX = style.translateX;
  if (typeof style.translateY === 'number') out.translateY = style.translateY;
  if (typeof style.rotation === 'number') out.rotation = style.rotation;

  const transform = style.transform;
  if (Array.isArray(transform)) {
    for (const entry of transform) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
        if (key === 'translateX' && typeof value === 'number') out.translateX = value;
        else if (key === 'translateY' && typeof value === 'number') out.translateY = value;
        else if (key === 'scale' && typeof value === 'number') out.scale = value;
        else if ((key === 'rotation' || key === 'rotate') && typeof value === 'number') {
          out.rotation = value;
        }
      }
    }
  }

  return out;
}

type CachedSceneLayerProps = {
  routeName: string;
  renderScreen: () => React.ReactNode;
  visible: boolean;
  lazy: boolean;
  bgColor: number;
};

function CachedSceneLayer({
  routeName,
  renderScreen,
  visible,
  lazy,
  bgColor,
}: CachedSceneLayerProps) {
  const hasMountedRef = React.useRef(false);
  const [contentReady, setContentReady] = React.useState(!lazy);

  React.useEffect(() => {
    if (!visible && !hasMountedRef.current) return;
    if (hasMountedRef.current) {
      setContentReady(true);
      return;
    }
    if (!lazy) {
      hasMountedRef.current = true;
      setContentReady(true);
      return;
    }
    const id = requestAnimationFrame(() => {
      hasMountedRef.current = true;
      setContentReady(true);
    });
    return () => cancelAnimationFrame(id);
  }, [lazy, routeName, visible]);

  if (!visible && !hasMountedRef.current) return null;

  const sceneSize = renderSize();

  return (
    <View
      style={[
        fill,
        {
          width: sceneSize.width,
          height: sceneSize.height,
          backgroundColor: bgColor,
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
        },
      ]}
    >
      {contentReady ? (
        <View style={{ width: sceneSize.width, height: sceneSize.height }}>
          {renderScreen()}
        </View>
      ) : null}
    </View>
  );
}

type SceneViewProps = {
  descriptor: DescriptorWithKey;
  isFocused: boolean;
  isClosing: boolean;
  renderContent: boolean;
  deferInitialRender?: boolean;
  lazyScreenContent?: boolean;
  initialProgress: number;
  defaultAnimation: StackAnimation;
  defaultDuration: number;
  bgColor: number;
  onEnterSettled?: (key: string) => void;
  onExitSettled: (key: string) => void;
};

function SceneView({
  descriptor,
  isFocused,
  isClosing,
  renderContent,
  deferInitialRender,
  lazyScreenContent,
  initialProgress,
  defaultAnimation,
  defaultDuration,
  bgColor,
  onEnterSettled,
  onExitSettled,
}: SceneViewProps) {
  const opts = (descriptor.options ?? {}) as RayactStackNavigationOptions;
  const animation = opts.animation ?? defaultAnimation;
  const duration = opts.animationDuration ?? defaultDuration;
  const target = isClosing ? 0 : 1;
  const interp = interpolators[animation] ?? slideFromRight;
  const deferByAnimation =
    animation === 'slide_from_right' ||
    animation === 'slide_from_bottom' ||
    animation === 'scale';
  const lazyDefault = false;

  const shouldDeferContent =
    isFocused &&
    initialProgress === 0 &&
    !isClosing &&
    animation !== 'none' &&
    animation !== 'fade' &&
    (deferInitialRender ?? opts.deferInitialRender ?? deferByAnimation) === true;

  const lazyScreen = lazyScreenContent ?? opts.lazy ?? lazyDefault;

  const viewRef = React.useRef<any>(null);
  const layoutRef = React.useRef<LayoutSize>(renderSize());
  const progressRef = React.useRef(initialProgress);
  const settledAtRef = React.useRef<number | null>(null);
  const hasMountedContentRef = React.useRef(false);
  const [layoutVersion, bumpLayoutVersion] = React.useReducer((x) => x + 1, 0);
  const [contentReady, setContentReady] = React.useState(
    !shouldDeferContent && !lazyScreen,
  );
  const [nodeIdReady, setNodeIdReady] = React.useReducer((x) => x + 1, 0);

  React.useEffect(() => {
    if (!renderContent) {
      setContentReady(false);
      return;
    }
    if (shouldDeferContent) {
      const id = requestAnimationFrame(() => setContentReady(true));
      return () => cancelAnimationFrame(id);
    }
    if (!lazyScreen) {
      hasMountedContentRef.current = true;
      setContentReady(true);
      return;
    }
    if (hasMountedContentRef.current) {
      setContentReady(true);
      return;
    }
    const id = requestAnimationFrame(() => {
      hasMountedContentRef.current = true;
      setContentReady(true);
    });
    return () => cancelAnimationFrame(id);
  }, [descriptor.route.key, lazyScreen, renderContent, shouldDeferContent]);

  React.useEffect(() => {
    perfLog('transition.shellMounted.ts', { route: descriptor.route.key });
  }, [descriptor.route.key]);

  React.useEffect(() => {
    if (contentReady && renderContent) {
      perfLog('transition.contentMounted.ts', { route: descriptor.route.key });
    }
  }, [contentReady, descriptor.route.key, renderContent]);

  const assignViewRef = React.useCallback((instance: { node?: { id?: number } } | null) => {
    viewRef.current = instance;
    if (instance?.node?.id != null) {
      setNodeIdReady();
    }
  }, []);

  const applyStyle = React.useCallback(
    (progress: number) => {
      const nodeId = viewRef.current?.node?.id;
      const host = globalThis as typeof globalThis & {
        __rayactSetAnimatedStyle?: (nodeId: number, partialStyle: Record<string, number>) => void;
      };
      if (typeof nodeId !== 'number' || typeof host.__rayactSetAnimatedStyle !== 'function') {
        return;
      }
      host.__rayactSetAnimatedStyle(
        nodeId,
        animatedStyleFrom(interp(progress, layoutRef.current)),
      );
    },
    [interp],
  );

  React.useEffect(() => {
    settledAtRef.current = null;
    progressRef.current = initialProgress;
  }, [descriptor.route.key, initialProgress, isClosing, isFocused]);

  const settle = React.useCallback(
    (value: number) => {
      if (settledAtRef.current === value) return;
      settledAtRef.current = value;
      if (value === 1 && isFocused) {
        onEnterSettled?.(descriptor.route.key);
      } else if (value === 0 && isClosing) {
        onExitSettled(descriptor.route.key);
      }
    },
    [descriptor.route.key, isClosing, isFocused, onEnterSettled, onExitSettled],
  );

  const onLayout = React.useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = e.nativeEvent.layout;
      if (layoutRef.current.width === width && layoutRef.current.height === height) return;
      layoutRef.current = { width, height };
      applyStyle(progressRef.current);
      bumpLayoutVersion();
    },
    [applyStyle],
  );

  const effectiveLayout = (): LayoutSize => {
    const layout = layoutRef.current;
    if (layout.width > 0 && layout.height > 0) return layout;
    const fallback = renderSize();
    if (fallback.width > 0 && fallback.height > 0) return fallback;
    return layout;
  };

  React.useLayoutEffect(() => {
    const nodeId = viewRef.current?.node?.id;
    const host = globalThis as typeof globalThis & {
      __rayactStartStyleAnimation?: (
        nodeId: number,
        targetStyle: Record<string, number>,
        config: Record<string, unknown>,
        onComplete?: () => void,
      ) => void;
      __rayactStopStyleAnimation?: (nodeId: number) => void;
      __rayactSetAnimatedStyle?: (nodeId: number, partialStyle: Record<string, number>) => void;
    };

    const from = progressRef.current;
    const diff = target - from;
    const layout = effectiveLayout();

    if (diff === 0 || animation === 'none' || duration <= 0) {
      applyStyle(target);
      settle(target);
      return;
    }

    perfLog('transition.animationStarted.ts', { route: descriptor.route.key, nodeId });

    if (
      typeof nodeId !== 'number' ||
      typeof host.__rayactStartStyleAnimation !== 'function' ||
      typeof host.__rayactSetAnimatedStyle !== 'function'
    ) {
      return;
    }

    host.__rayactStopStyleAnimation?.(nodeId);
    host.__rayactSetAnimatedStyle(nodeId, animatedStyleFrom(interp(from, layout)));
    host.__rayactStartStyleAnimation(
      nodeId,
      animatedStyleFrom(interp(target, layout)),
      { type: 'timing', duration, easing: 'easeInOutCubic' },
      () => {
        progressRef.current = target;
        settle(target);
      },
    );
    return () => {
      host.__rayactStopStyleAnimation?.(nodeId);
    };
  }, [animation, applyStyle, duration, interp, layoutVersion, nodeIdReady, settle, target]);

  React.useEffect(() => {
    const nodeId = viewRef.current?.node?.id;
    const host = globalThis as typeof globalThis & {
      __rayactSetAnimatedStyle?: (nodeId: number, partialStyle: Record<string, number>) => void;
    };

    const from = progressRef.current;
    const diff = target - from;
    if (diff === 0 || animation === 'none' || duration <= 0) return;

    if (
      typeof nodeId === 'number' &&
      typeof host.__rayactSetAnimatedStyle === 'function'
    ) {
      return;
    }

    const layout = effectiveLayout();
    let frameId: number | null = null;
    let start: number | null = null;
    const step = (timestamp: number) => {
      if (start === null) start = timestamp;
      const elapsed = timestamp - start;
      const t = duration <= 0 ? 1 : Math.min(1, elapsed / duration);
      const progress = from + diff * easeInOutCubic(t);
      progressRef.current = progress;
      applyStyle(progress);
      if (t < 1) {
        frameId = requestAnimationFrame(step);
      } else {
        progressRef.current = target;
        applyStyle(target);
        settle(target);
      }
    };

    frameId = requestAnimationFrame(step);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [animation, applyStyle, duration, interp, layoutVersion, nodeIdReady, settle, target]);

  const ViewTag = 'rayact-view' as any;
  const sceneSize = layoutRef.current.width > 0 && layoutRef.current.height > 0
    ? layoutRef.current
    : renderSize();

  return (
    <ViewTag
      ref={assignViewRef}
      onLayout={onLayout}
      style={[
        fill,
        {
          width: sceneSize.width,
          height: sceneSize.height,
          backgroundColor: bgColor,
          pointerEvents: isFocused ? 'auto' : 'none',
        },
        interp(initialProgress, sceneSize),
      ]}
    >
      {renderContent && contentReady ? (
        <View style={{ width: sceneSize.width, height: sceneSize.height }}>
          {descriptor.render()}
        </View>
      ) : null}
    </ViewTag>
  );
}

function DefaultBackHandler({
  navigation,
  state,
}: {
  navigation: StackActionHelpers<ParamListBase>;
  state: StackNavigationState<ParamListBase>;
}) {
  React.useEffect(() => {
    const globalObject = globalThis as typeof globalThis & {
      __rayactHandleNavigationBackPress?: () => boolean;
    };
    const handler = () => {
      if (state.routes.length > 1) {
        perfLog('nav.press.ts', { action: 'pop' });
        navigation.pop();
        return true;
      }
      return false;
    };
    globalObject.__rayactHandleNavigationBackPress = handler;
    return () => {
      if (globalObject.__rayactHandleNavigationBackPress === handler) {
        delete globalObject.__rayactHandleNavigationBackPress;
      }
    };
  }, [navigation, state.routes.length]);

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (state.routes.length > 1) {
        perfLog('nav.press.ts', { action: 'hardwareBack' });
        navigation.pop();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [navigation, state.routes.length]);

  return null;
}

function StackNavigator({
  id,
  initialRouteName,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  animation: defaultAnimation = 'slide_from_right',
  animationDuration: defaultDuration = 280,
  cacheScreensByName = false,
  lazyScreens = false,
  ...rest
}: Props) {
  const forceUpdate = React.useReducer((x) => x + 1, 0)[1];
  void rest;

  const { state, descriptors, navigation, NavigationContent } =
    useNavigationBuilder<
      StackNavigationState<ParamListBase>,
      StackRouterOptions,
      StackActionHelpers<ParamListBase>,
      RayactStackNavigationOptions,
      Record<string, never>
    >(StackRouter, {
      id,
      initialRouteName,
      children,
      layout,
      screenListeners,
      screenOptions,
      screenLayout,
    });

  const descriptorsCacheRef = React.useRef<Record<string, DescriptorWithKey>>({});
  Object.assign(descriptorsCacheRef.current, descriptors);

  const seenRouteKeysRef = React.useRef<Set<string>>(new Set());
  const previousRoutesRef = React.useRef<RouteSnapshot[]>([]);
  const closingKeysRef = React.useRef<Set<string>>(new Set());
  const closingDescriptorsRef = React.useRef<Map<string, DescriptorWithKey>>(new Map());
  const topRouteSettledRef = React.useRef(true);
  const visitedNamesRef = React.useRef<Set<string>>(
    new Set(initialRouteName ? [initialRouteName] : []),
  );
  const descriptorByNameRef = React.useRef<Map<string, DescriptorWithKey>>(new Map());
  const renderByNameRef = React.useRef<Map<string, () => React.ReactNode>>(new Map());

  const shouldCacheRoute = React.useCallback(
    (routeName: string, options: RayactStackNavigationOptions): boolean => {
      if (options.cacheByName === true) return true;
      if (options.cacheByName === false) return false;
      return cacheScreensByName === true;
    },
    [cacheScreensByName],
  );

  const isRouteCached = React.useCallback(
    (routeName: string, options?: RayactStackNavigationOptions): boolean => {
      const opts = options ?? {};
      return shouldCacheRoute(routeName, opts) && visitedNamesRef.current.has(routeName);
    },
    [shouldCacheRoute],
  );

  const theme = useTheme();
  const bgColor =
    ((globalThis as { __rayactConfig?: { backgroundColor?: number } })
      .__rayactConfig?.backgroundColor ??
      (typeof theme.surface === 'number' ? theme.surface : 0x000000ff)) >>> 0;

  React.useLayoutEffect(() => {
    const currentKeys = new Set(state.routes.map((route) => route.key));
    let changed = false;

    for (const previous of previousRoutesRef.current) {
      if (currentKeys.has(previous.key) || closingKeysRef.current.has(previous.key)) continue;
      const descriptor = descriptorsCacheRef.current[previous.key] ?? previous.descriptor;
      closingKeysRef.current.add(previous.key);
      closingDescriptorsRef.current.set(previous.key, descriptor);
      changed = true;
    }

    if (state.routes.length > state.index) {
      const focused = state.routes[state.index];
      if (focused && !seenRouteKeysRef.current.has(focused.key) && state.routes.length > 1) {
        topRouteSettledRef.current = false;
      }
    }

    previousRoutesRef.current = state.routes.map((route) => ({
      key: route.key,
      descriptor: descriptors[route.key] as DescriptorWithKey,
    }));

    if (changed) forceUpdate();
  }, [descriptors, forceUpdate, state.routes]);

  const focusedRoute = state.routes[state.index];
  const focusedKey = focusedRoute?.key;
  const focusedDescriptor = focusedKey
    ? (descriptors[focusedKey] as DescriptorWithKey)
    : undefined;
  const backgroundRoutes = state.routes.slice(0, state.index);
  const isPushing = state.routes.length > 1 && !topRouteSettledRef.current;
  const overlayActive = state.routes.length > 1;

  for (const route of state.routes) {
    const descriptor = descriptors[route.key] as DescriptorWithKey | undefined;
    if (!descriptor) continue;
    descriptorByNameRef.current.set(route.name, descriptor);
    renderByNameRef.current.set(route.name, () => descriptor.render());
    const options = (descriptor.options ?? {}) as RayactStackNavigationOptions;
    if (shouldCacheRoute(route.name, options)) {
      visitedNamesRef.current.add(route.name);
    }
  }

  if (focusedRoute && focusedDescriptor) {
    const options = (focusedDescriptor.options ?? {}) as RayactStackNavigationOptions;
    if (shouldCacheRoute(focusedRoute.name, options)) {
      visitedNamesRef.current.add(focusedRoute.name);
    }
  }

  const cachedRouteNames = Array.from(visitedNamesRef.current).filter((name) => {
    const descriptor = descriptorByNameRef.current.get(name);
    const options = (descriptor?.options ?? {}) as RayactStackNavigationOptions;
    return shouldCacheRoute(name, options);
  });

  const focusedUsesCache =
    !!focusedRoute &&
    !!focusedDescriptor &&
    isRouteCached(
      focusedRoute.name,
      (focusedDescriptor.options ?? {}) as RayactStackNavigationOptions,
    ) &&
    !overlayActive;

  const backgroundRenderContent = (
    route: (typeof state.routes)[number],
    options: RayactStackNavigationOptions,
  ): boolean => {
    if (options.detachInactiveScreens !== true) return true;
    if (isPushing && options.keepPreviousRouteMounted !== false) return true;
    if (!topRouteSettledRef.current) return true;
    return false;
  };

  return (
    <NavigationContent>
      <DefaultBackHandler navigation={navigation} state={state} />
      <View style={{ flex: 1, backgroundColor: bgColor }}>
        {cachedRouteNames.map((name) => {
          const renderScreen = renderByNameRef.current.get(name);
          if (!renderScreen) return null;
          const descriptor = descriptorByNameRef.current.get(name);
          const options = (descriptor?.options ?? {}) as RayactStackNavigationOptions;
          const lazy = lazyScreens && options.lazy !== false;
          return (
            <CachedSceneLayer
              key={`cached-${name}`}
              routeName={name}
              renderScreen={renderScreen}
              visible={focusedUsesCache && focusedRoute?.name === name}
              lazy={lazy}
              bgColor={bgColor}
            />
          );
        })}
        {backgroundRoutes.map((route) => {
          const descriptor = descriptors[route.key] as DescriptorWithKey;
          const options = (descriptor.options ?? {}) as RayactStackNavigationOptions;
          if (isRouteCached(route.name, options)) return null;
          return (
            <SceneView
              key={route.key}
              descriptor={descriptor}
              isFocused={false}
              isClosing={false}
              renderContent={backgroundRenderContent(route, options)}
              lazyScreenContent={lazyScreens}
              initialProgress={1}
              defaultAnimation={defaultAnimation}
              defaultDuration={defaultDuration}
              bgColor={bgColor}
              onExitSettled={() => {}}
            />
          );
        })}
        {focusedDescriptor && focusedRoute && !focusedUsesCache ? (
          <SceneView
            key={focusedRoute.key}
            descriptor={focusedDescriptor}
            isFocused={true}
            isClosing={false}
            renderContent={true}
            lazyScreenContent={lazyScreens}
            initialProgress={
              (() => {
                const opts = (focusedDescriptor.options ?? {}) as RayactStackNavigationOptions;
                const anim = opts.animation ?? defaultAnimation;
                if (anim === 'none') return 1;
                return seenRouteKeysRef.current.has(focusedRoute.key) || state.routes.length <= 1
                  ? 1
                  : 0;
              })()
            }
            defaultAnimation={defaultAnimation}
            defaultDuration={defaultDuration}
            bgColor={bgColor}
            onEnterSettled={(key) => {
              seenRouteKeysRef.current.add(key);
              if (topRouteSettledRef.current) return;
              topRouteSettledRef.current = true;
              forceUpdate();
            }}
            onExitSettled={() => {}}
          />
        ) : null}
        {Array.from(closingDescriptorsRef.current.entries()).map(([key, descriptor]) => {
          const options = (descriptor.options ?? {}) as RayactStackNavigationOptions;
          if (isRouteCached(descriptor.route.name, options)) return null;
          return (
            <SceneView
              key={`closing-${key}`}
              descriptor={descriptor}
              isFocused={false}
              isClosing={true}
              renderContent={true}
              lazyScreenContent={lazyScreens}
              initialProgress={1}
              defaultAnimation={defaultAnimation}
              defaultDuration={defaultDuration}
              bgColor={bgColor}
              onExitSettled={(settledKey) => {
                closingKeysRef.current.delete(settledKey);
                closingDescriptorsRef.current.delete(settledKey);
                forceUpdate();
              }}
            />
          );
        })}
      </View>
    </NavigationContent>
  );
}

export const createStackNavigator = createNavigatorFactory(StackNavigator);
export const createNativeStackNavigator = createStackNavigator;

export const NavigationContainer = React.forwardRef<
  unknown,
  React.ComponentProps<typeof BaseNavigationContainer>
>(function NavigationContainer(props, ref) {
  return <BaseNavigationContainer ref={ref as never} {...props} />;
});

export const navigationBackend = 'layered';

export {
  useNavigation,
  useRoute,
  useFocusEffect,
  useIsFocused,
  useNavigationState,
} from '@react-navigation/core';
export { CommonActions, StackActions } from '@react-navigation/routers';
export { BackHandler, useBackHandler } from '@rayact/react';
export type { BackHandlerSubscription } from '@rayact/react';
