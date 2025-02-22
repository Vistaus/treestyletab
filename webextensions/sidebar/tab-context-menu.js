/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import MenuUI from '/extlib/MenuUI.js';

import {
  log as internalLogger,
  wait,
  notify,
  configs,
  shouldApplyAnimation,
  compareAsNumber,
  isLinux,
  isMacOS,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as BackgroundConnection from './background-connection.js';
import * as Constants from '/common/constants.js';
import * as ContextualIdentities from '/common/contextual-identities.js';
import * as EventUtils from './event-utils.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import EventListenerManager from '/extlib/EventListenerManager.js';

function log(...args) {
  internalLogger('sidebar/tab-context-menu', ...args);
}

export const onTabsClosing = new EventListenerManager();

let mUI;
let mMenu;

let mNewTabButtonUI;
let mNewTabButtonMenu;

let mContextTab      = null;
let mLastOpenOptions = null;
let mIsDirty         = false;

const mExtraItems = new Map();

export function init() {
  mMenu = document.querySelector('#tabContextMenu');
  mNewTabButtonMenu = document.querySelector('#newTabButtonContextMenu');
  document.addEventListener('contextmenu', onContextMenu, { capture: true });

  const commonOptions = {
    appearance:        'menu',
    animationDuration: shouldApplyAnimation() ? configs.collapseDuration : 0.001,
    subMenuOpenDelay:  configs.subMenuOpenDelay,
    subMenuCloseDelay: configs.subMenuCloseDelay,
  };
  mUI = new MenuUI({
    ...commonOptions,
    root: mMenu,
    onCommand,
    //onShown,
    onHidden,
  });
  mNewTabButtonUI = new MenuUI({
    ...commonOptions,
    root: mNewTabButtonMenu,
    onCommand: onNewTabButtonMenuCommand,
  });

  browser.runtime.onMessage.addListener(onMessage);
  TSTAPI.onMessageExternal.addListener(onMessageExternal);

  browser.runtime.sendMessage({
    type: Constants.kCOMMAND_GET_CONTEXT_MENU_ITEMS
  }).then(items => {
    importExtraItems(items);
    mIsDirty = true;
  }).catch(ApiTabs.createErrorSuppressor());

  updateContextualIdentitiesSelector();
}

async function rebuild() {
  if (!mIsDirty)
    return;

  mIsDirty = false;

  const firstExtraItem = mMenu.querySelector('.extra, .imitated');
  if (firstExtraItem) {
    const range = document.createRange();
    range.selectNodeContents(mMenu);
    range.setStartBefore(firstExtraItem);
    range.deleteContents();
    range.detach();
  }

  if (mExtraItems.size == 0)
    return;

  const extraItemNodes = document.createDocumentFragment();
  const incognitoParams = { windowId: TabsStore.getCurrentWindowId() };
  for (const [id, extraItems] of mExtraItems.entries()) {
    const addon = TSTAPI.getAddon(id);
    if (!TSTAPI.isSafeAtIncognito(id, incognitoParams) ||
        !addon)
      continue;
    let addonItem = document.createElement('li');
    const name = getAddonName(id);
    addonItem.appendChild(document.createTextNode(name));
    addonItem.setAttribute('title', name);
    addonItem.classList.add('extra');
    const icon = getAddonIcon(id);
    if (icon)
      addonItem.dataset.icon = icon;
    prepareAsSubmenu(addonItem);

    const toBeBuiltItems = [];
    for (const item of extraItems) {
      if (item.visible === false)
        continue;
      if (item.contexts && !item.contexts.includes('tab'))
        continue;
      if (item.documentUrlPatterns &&
          (!item.viewTypes ||
           !item.viewTypes.includes('sidebar') ||
           item.documentUrlPatterns.some(pattern => !/^moz-extension:/.test(pattern)) ||
           !matchesToPattern(location.href, item.documentUrlPatterns)) &&
          mContextTab &&
          !matchesToPattern(mContextTab.url, item.documentUrlPatterns))
        continue;
      toBeBuiltItems.push(item);
    }
    const topLevelItems = toBeBuiltItems.filter(item => !item.parentId);
    if (topLevelItems.length == 1 &&
        !topLevelItems[0].icons)
      topLevelItems[0].icons = addon.icons || {};

    const addonSubMenu = addonItem.lastChild;
    const knownItems   = {};
    for (const item of toBeBuiltItems) {
      const itemNode = buildExtraItem(item, id);
      if (item.parentId) {
        if (item.parentId in knownItems) {
          const parent = knownItems[item.parentId];
          prepareAsSubmenu(parent);
          parent.lastChild.appendChild(itemNode);
        }
        else {
          continue;
        }
      }
      else {
        addonSubMenu.appendChild(itemNode);
      }
      knownItems[item.id] = itemNode;
    }
    if (id == browser.runtime.id) {
      for (const item of addonSubMenu.children) {
        if (!item.nextSibling) // except the last "Tree Style Tab" menu
          continue;
        item.classList.remove('extra');
        item.classList.add('imitated');
      }
      const range = document.createRange();
      range.selectNodeContents(addonSubMenu);
      extraItemNodes.appendChild(range.extractContents());
      range.detach();
      continue;
    }
    switch (addonSubMenu.childNodes.length) {
      case 0:
        break;
      case 1:
        addonItem = addonSubMenu.removeChild(addonSubMenu.firstChild);
        extraItemNodes.appendChild(addonItem);
      default:
        extraItemNodes.appendChild(addonItem);
        break;
    }
  }
  if (!extraItemNodes.hasChildNodes())
    return;

  mMenu.appendChild(extraItemNodes);
}

function getAddonName(id) {
  if (id == browser.runtime.id)
    return browser.i18n.getMessage('extensionName');
  const addon = TSTAPI.getAddon(id) || {};
  return addon.name || id.replace(/@.+$/, '');
}

function getAddonIcon(id) {
  const addon = TSTAPI.getAddon(id) || {};
  return chooseIconForAddon({
    id:         id,
    internalId: addon.internalId,
    icons:      addon.icons || {}
  });
}

function chooseIconForAddon(params) {
  const icons = params.icons || {};
  const addon = TSTAPI.getAddon(params.id) || {};
  let sizes = Object.keys(icons).map(aSize => parseInt(aSize)).sort(compareAsNumber);
  const reducedSizes = sizes.filter(aSize => aSize < 16);
  if (reducedSizes.length > 0)
    sizes = reducedSizes;
  const size = sizes[0] || null;
  if (!size)
    return null;
  let url = icons[size];
  if (!/^\w+:\/\//.test(url))
    url = `moz-extension://${addon.internalId || params.internalId}/${url.replace(/^\//, '')}`;
  return url;
}

function prepareAsSubmenu(itemNode) {
  if (itemNode.querySelector('ul'))
    return itemNode;
  itemNode.appendChild(document.createElement('ul'));
  return itemNode;
}

function buildExtraItem(item, ownerAddonId) {
  const itemNode = document.createElement('li');
  itemNode.setAttribute('id', `${ownerAddonId}-${item.id}`);
  itemNode.setAttribute('data-item-id', item.id);
  itemNode.setAttribute('data-item-owner-id', ownerAddonId);
  itemNode.classList.add('extra');
  itemNode.classList.add(item.type || 'normal');
  if (item.type == 'checkbox' || item.type == 'radio') {
    if (item.checked)
      itemNode.classList.add('checked');
  }
  if (item.type != 'separator') {
    itemNode.appendChild(document.createTextNode(item.title));
    itemNode.setAttribute('title', item.title);
  }
  itemNode.classList.toggle('disabled', item.enabled === false);
  const addon = TSTAPI.getAddon(ownerAddonId) || {};
  const icon = chooseIconForAddon({
    id:         ownerAddonId,
    internalId: addon.internalId,
    icons:      item.icons || {}
  });
  if (icon)
    itemNode.dataset.icon = icon;
  return itemNode;
}

function matchesToPattern(url, patterns) {
  if (!Array.isArray(patterns))
    patterns = [patterns];
  for (const pattern of patterns) {
    if (matchPatternToRegExp(pattern).test(url))
      return true;
  }
  return false;
}
// https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Match_patterns
const matchPattern = /^(?:(\*|http|https|file|ftp|app|moz-extension):\/\/([^\/]+|)\/?(.*))$/i;
function matchPatternToRegExp(pattern) {
  if (pattern === '<all_urls>')
    return (/^(?:https?|file|ftp|app):\/\//);
  const match = matchPattern.exec(pattern);
  if (!match)
    throw new TypeError(`"${pattern}" is not a valid MatchPattern`);

  const [, scheme, host, path,] = match;
  return new RegExp('^(?:'
                    + (scheme === '*' ? 'https?' : escape(scheme)) + ':\\/\\/'
                    + (host === '*' ? '[^\\/]*' : escape(host).replace(/^\*\./g, '(?:[^\\/]+)?'))
                    + (path ? (path == '*' ? '(?:\\/.*)?' : ('\\/' + escape(path).replace(/\*/g, '.*'))) : '\\/?')
                    + ')$');
}

export async function open(options = {}) {
  await close();
  mLastOpenOptions = options;
  mContextTab      = options.tab && Tab.get(options.tab.id);
  await rebuild();
  if (mIsDirty) {
    return await open(options);
  }
  applyContext();
  const originalCanceller = options.canceller;
  options.canceller = () => {
    return (typeof originalCanceller == 'function' && originalCanceller()) || mIsDirty;
  };
  await mUI.open(options);
  if (mIsDirty) {
    return await open(options);
  }
}

export async function close() {
  await mUI.close();
  mMenu.removeAttribute('data-tab-id');
  mMenu.removeAttribute('data-tab-states');
  mContextTab      = null;
  mLastOpenOptions = null;
}

function applyContext() {
  if (mContextTab) {
    mMenu.setAttribute('data-tab-id', mContextTab.id);
    const states = [];
    if (mContextTab.active)
      states.push('active');
    if (mContextTab.pinned)
      states.push('pinned');
    if (mContextTab.audible)
      states.push('audible');
    if (mContextTab.$TST.muted)
      states.push('muted');
    if (mContextTab.discarded)
      states.push('discarded');
    if (mContextTab.incognito)
      states.push('incognito');
    if (mContextTab.$TST.multiselected)
      states.push('multiselected');
    mMenu.setAttribute('data-tab-states', states.join(' '));
  }
}

async function onCommand(item, event) {
  if (event.button == 1)
    return;

  const contextTab = mContextTab;
  wait(0).then(() => close()); // close the menu immediately!

  const id = item.getAttribute('data-item-id');
  if (!id)
    return;

  const modifiers = [];
  if (event.metaKey)
    modifiers.push('Command');
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
    if (isMacOS())
      modifiers.push('MacCtrl');
  }
  if (event.shiftKey)
    modifiers.push('Shift');
  const owner      = item.getAttribute('data-item-owner-id');
  const checked    = item.matches('.radio, .checkbox:not(.checked)');
  const wasChecked = item.matches('.radio.checked, .checkbox.checked');
  const message = {
    type: TSTAPI.kCONTEXT_MENU_CLICK,
    info: {
      checked,
      editable:         false,
      frameUrl:         null,
      linkUrl:          null,
      mediaType:        null,
      menuItemId:       id,
      button:           event.button,
      modifiers:        modifiers,
      pageUrl:          null,
      parentMenuItemId: null,
      selectionText:    null,
      srcUrl:           null,
      wasChecked
    },
    tab: contextTab,
  };
  if (owner == browser.runtime.id) {
    await browser.runtime.sendMessage(message).catch(ApiTabs.createErrorSuppressor());
  }
  else if (TSTAPI.isSafeAtIncognito(owner, { tab: contextTab, windowId: TabsStore.getCurrentWindowId() })) {
    const cache = {};
    await Promise.all([
      TSTAPI.sendMessage(
        owner,
        message,
        { tabProperties: ['tab'], cache, isContextTab: true }
      ).catch(ApiTabs.createErrorSuppressor()),
      TSTAPI.sendMessage(
        owner,
        {
          ...message,
          type: TSTAPI.kFAKE_CONTEXT_MENU_CLICK
        },
        { tabProperties: ['tab'], cache, isContextTab: true }
      ).catch(ApiTabs.createErrorSuppressor())
    ]);
  }

  if (item.matches('.checkbox')) {
    item.classList.toggle('checked');
    for (const itemData of mExtraItems.get(item.dataset.itemOwnerId)) {
      if (itemData.id != item.dataset.itemId)
        continue;
      itemData.checked = item.matches('.checked');
      browser.runtime.sendMessage({
        type:    Constants.kCOMMAND_NOTIFY_CONTEXT_ITEM_CHECKED_STATUS_CHANGED,
        id:      item.dataset.itemId,
        ownerId: item.dataset.itemOwnerId,
        checked: itemData.checked
      }).catch(ApiTabs.createErrorSuppressor());
      break;
    }
    mIsDirty = true;
  }
  else if (item.matches('.radio')) {
    const currentRadioItems = new Set();
    let radioItems = null;
    for (const itemData of mExtraItems.get(item.dataset.itemOwnerId)) {
      if (itemData.type == 'radio') {
        currentRadioItems.add(itemData);
      }
      else if (radioItems == currentRadioItems) {
        break;
      }
      else {
        currentRadioItems.clear();
      }
      if (itemData.id == item.dataset.itemId)
        radioItems = currentRadioItems;
    }
    if (radioItems) {
      for (const itemData of radioItems) {
        itemData.checked = itemData.id == item.dataset.itemId;
        const radioItem = document.getElementById(`${item.dataset.itemOwnerId}-${itemData.id}`);
        if (radioItem)
          radioItem.classList.toggle('checked', itemData.checked);
        browser.runtime.sendMessage({
          type:    Constants.kCOMMAND_NOTIFY_CONTEXT_ITEM_CHECKED_STATUS_CHANGED,
          id:      item.dataset.itemId,
          ownerId: item.dataset.itemOwnerId,
          checked: itemData.checked
        }).catch(ApiTabs.createErrorSuppressor());
      }
    }
    mIsDirty = true;
  }
}

async function onShown(contextTab) {
  contextTab = contextTab || mContextTab
  const message = {
    type: TSTAPI.kCONTEXT_MENU_SHOWN,
    info: {
      editable:         false,
      frameUrl:         null,
      linkUrl:          null,
      mediaType:        null,
      pageUrl:          null,
      selectionText:    null,
      srcUrl:           null,
      contexts:         ['tab'],
      menuIds:          [],
      viewType:         'sidebar',
      bookmarkId:       null
    },
    tab: contextTab,
    windowId: TabsStore.getCurrentWindowId()
  };
  const cache = {};
  const result = Promise.all([
    browser.runtime.sendMessage({
      ...message,
      tab: message.tab && await TSTAPI.exportTab(message.tab, browser.runtime.id, { cache })
    }).catch(ApiTabs.createErrorSuppressor()),
    TSTAPI.broadcastMessage(
      message,
      { tabProperties: ['tab'], cache, isContextTab: true }
    ),
    TSTAPI.broadcastMessage(
      {
        ...message,
        type: TSTAPI.kFAKE_CONTEXT_MENU_SHOWN
      },
      { tabProperties: ['tab'], cache, isContextTab: true }
    ),
  ]);
  return result;
}

async function onHidden() {
  const message = {
    type: TSTAPI.kCONTEXT_MENU_HIDDEN,
    windowId: TabsStore.getCurrentWindowId()
  };
  return Promise.all([
    browser.runtime.sendMessage(message).catch(ApiTabs.createErrorSuppressor()),
    TSTAPI.broadcastMessage(message),
    TSTAPI.broadcastMessage({
      ...message,
      type: TSTAPI.kFAKE_CONTEXT_MENU_HIDDEN
    })
  ]);
}


function updateContextualIdentitiesSelector() {
  const disabled = document.documentElement.classList.contains('incognito') || ContextualIdentities.getCount() == 0;

  const range    = document.createRange();
  range.selectNodeContents(mNewTabButtonMenu);
  range.deleteContents();

  if (disabled)
    return;

  const fragment = ContextualIdentities.generateMenuItems({
    hasDefault: true,
  });
  range.insertNode(fragment);
  range.detach();
}

ContextualIdentities.onUpdated.addListener(() => {
  updateContextualIdentitiesSelector();
});

async function onNewTabButtonMenuCommand(item, event) {
  if (item.dataset.value) {
    const action = EventUtils.isAccelAction(event) ?
      configs.autoAttachOnNewTabButtonMiddleClick :
      configs.autoAttachOnNewTabCommand;
    BackgroundConnection.sendMessage({
      type:          Constants.kCOMMAND_NEW_TAB_AS,
      baseTabId:     Tab.getActiveTab(TabsStore.getCurrentWindowId()).id,
      as:            action,
      cookieStoreId: item.dataset.value,
      inBackground:  event.shiftKey,
    });
  }

  mNewTabButtonUI.close();
}


function onMessage(message, _sender) {
  log('tab-context-menu: internally called:', message);
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TABS_CLOSING:
      // Don't respond to message for other windows, because
      // the sender receives only the firstmost response.
      if (message.windowId != TabsStore.getCurrentWindowId())
        return;
      return Promise.resolve(onTabsClosing.dispatch(message.tabs));

    case Constants.kCOMMAND_NOTIFY_CONTEXT_MENU_UPDATED: {
      importExtraItems(message.items);
      mIsDirty = true;
      if (mUI.opened)
        open(mLastOpenOptions);
    }; break;
  }
}

function importExtraItems(importedItems) {
  mExtraItems.clear();
  for (const [id, items] of Object.entries(importedItems)) {
    mExtraItems.set(id, items);
  }
}

let mReservedOverrideContext = null;

function onMessageExternal(message, sender) {
  switch (message.type) {
    case TSTAPI.kCONTEXT_MENU_OPEN:
    case TSTAPI.kFAKE_CONTEXT_MENU_OPEN:
      log('TSTAPI.kCONTEXT_MENU_OPEN:', message, { id: sender.id, url: sender.url });
      return (async () => {
        const tab      = message.tab ? Tab.get(message.tab) : null ;
        const windowId = message.window || tab && tab.windowId;
        if (windowId != TabsStore.getCurrentWindowId())
          return;
        await onShown(tab);
        await wait(25);
        return open({
          tab,
          left:     message.left,
          top:      message.top
        });
      })();

    case TSTAPI.kOVERRIDE_CONTEXT:
      if (message.windowId != TabsStore.getCurrentWindowId())
        return;
      mReservedOverrideContext = (
        message.context == 'bookmark' ?
          { context:    'bookmark',
            bookmarkId: message.bookmarkId } :
          message.context == 'tab' ?
            { context:    'tab',
              tabId:      message.tabId } :
            null
      );
      if (mReservedOverrideContext) {
        if (reserveToActivateSubpanel.reserved) {
          clearTimeout(reserveToActivateSubpanel.reserved);
          reserveToActivateSubpanel.reserved = null;
        }
        browser.runtime.sendMessage({
          type:     Constants.kCOMMAND_NOTIFY_CONTEXT_OVERRIDDEN,
          context:  mReservedOverrideContext,
          windowId: message.windowId,
          owner:    sender.id
        });
        // We need to ignore mouse events on the iframe, to handle
        // the contextmenu event on this parent frame side.
        document.getElementById('subpanel').style.pointerEvents = 'none';
      }
      break;
  }
}

function reserveToActivateSubpanel() {
  if (reserveToActivateSubpanel.reserved)
    clearTimeout(reserveToActivateSubpanel.reserved);
  reserveToActivateSubpanel.reserved = setTimeout(() => {
    reserveToActivateSubpanel.reserved = null;
    document.getElementById('subpanel').style.pointerEvents = '';
  }, 100);
}
reserveToActivateSubpanel.reserved = null;

// safe guard
window.addEventListener('mouseup', _event => {
  reserveToActivateSubpanel();
});

async function onContextMenu(event) {
  reserveToActivateSubpanel();
  log('onContextMenu: start');

  const context = mReservedOverrideContext;
  mReservedOverrideContext = null;

  const target         = EventUtils.getElementTarget(event);
  const originalTarget = EventUtils.getElementOriginalTarget(event);
  const onInputField   = (
    target.closest('input, textarea') ||
    originalTarget.closest('input, textarea')
  );
  log('onContextMenu: ', { target, originalTarget, onInputField, context });

  if (!onInputField && context?.context) {
    log('onContextMenu: override context aso something given: ', context);
    try {
      browser.menus.overrideContext(context);
    }
    catch(error) {
      console.log('failed to override context: ', error);
      try {
        if (context.context == 'bookmark' &&
            !(await Permissions.isGranted(Permissions.BOOKMARKS)))
          notify({
            title:   browser.i18n.getMessage('bookmarkContext_notification_notPermitted_title'),
            message: browser.i18n.getMessage(`bookmarkContext_notification_notPermitted_message${isLinux() ? '_linux' : ''}`),
            url:     `moz-extension://${location.host}/options/options.html#bookmarksPermissionGranted_context`
          });
        else
          console.error(error);
      }
      catch(error) {
        console.error(error);
      }
    }
    return;
  }

  console.log('notify context menu is overridden');
  browser.runtime.sendMessage({
    type:    Constants.kCOMMAND_NOTIFY_CONTEXT_OVERRIDDEN,
    context: null
  });

  if (onInputField) {
    console.log('ignroe request on a input field');
    return;
  }

  const modifierKeyPressed = isMacOS() ? event.metaKey : event.ctrlKey;

  const originalTargetBookmarkElement = originalTarget && originalTarget.closest('[data-bookmark-id]');
  const bookmarkId = originalTargetBookmarkElement && originalTargetBookmarkElement.dataset.bookmarkId;
  if (bookmarkId &&
      !modifierKeyPressed &&
      typeof browser.menus.overrideContext == 'function') {
    log('onContextMenu: override context as bookmark context menu');
    browser.menus.overrideContext({
      context:    'bookmark',
      bookmarkId: bookmarkId
    });
    return;
  }

  const originalTargetTabElement = originalTarget && originalTarget.closest('[data-tab-id]');
  const tab = originalTargetTabElement ?
    TabsStore.ensureLivingTab(Tab.get(parseInt(originalTargetTabElement.dataset.tabId))) :
    EventUtils.getTabFromEvent(event);
  if (tab &&
      !modifierKeyPressed &&
      typeof browser.menus.overrideContext == 'function') {
    log('onContextMenu: override context as tab context menu');
    browser.menus.overrideContext({
      context: 'tab',
      tabId: tab.id
    });
    return;
  }

  if (EventUtils.isEventFiredOnNewTabButton(event)) {
    log('onContextMenu: on new tab button');
    event.stopPropagation();
    event.preventDefault();
    mNewTabButtonUI.open({
      left: event.clientX,
      top:  event.clientY,
    });
    return;
  }

  if (event.target == document.body) { // when the application key is pressed
    log('onContextMenu: override context as tab context menu for blank area');
    browser.menus.overrideContext({
      context: 'tab',
      tabId:   Tab.getActiveTab(TabsStore.getCurrentWindowId()).id,
    });
    return;
  }

  if (!configs.emulateDefaultContextMenu) {
    log('onContextMenu: no emulation');
    return;
  }

  log('onContextMenu: show emulated context menu');
  event.stopPropagation();
  event.preventDefault();
  await onShown(tab);
  await wait(25);
  await open({
    tab,
    left: event.clientX,
    top:  event.clientY
  });
}

BackgroundConnection.onMessage.addListener(async message => {
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TAB_CREATED:
    case Constants.kCOMMAND_NOTIFY_TAB_MOVED:
    case Constants.kCOMMAND_NOTIFY_TAB_REMOVING:
    case Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED:
    case Constants.kCOMMAND_NOTIFY_TAB_PINNED:
    case Constants.kCOMMAND_NOTIFY_TAB_UNPINNED:
    case Constants.kCOMMAND_NOTIFY_TAB_SHOWN:
    case Constants.kCOMMAND_NOTIFY_TAB_HIDDEN:
    case Constants.kCOMMAND_NOTIFY_CHILDREN_CHANGED:
      close();
      mNewTabButtonUI.close();
      break;
  }
});
