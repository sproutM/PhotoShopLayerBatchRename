#target photoshop

var SCRIPT_NAME = "批量重命名图层";
var SCRIPT_VERSION = "1.0.2";
var ERROR_LOG_FILE = "LayerBatchRename_ErrorLog.txt";
var SETTINGS_FILE = "LayerBatchRename_Settings.ini";
var VAR_CHARS = "1234567890abcefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
var MAX_VARS = VAR_CHARS.length;
var _varCharPosMap = null;
var _escapeRegexMap = null;

function initLookupMaps() {
    if (!_varCharPosMap) {
        _varCharPosMap = {};
        for (var i = 0; i < VAR_CHARS.length; i++) {
            _varCharPosMap[VAR_CHARS.charAt(i)] = i + 1;
        }
    }
    if (!_escapeRegexMap) {
        _escapeRegexMap = {};
        var special = "\\^$.*+?()[]{}|";
        for (var j = 0; j < special.length; j++) {
            _escapeRegexMap[special.charAt(j)] = true;
        }
    }
}

var ERROR_CODES = {
    E001: { msg: "未打开任何文档", detail: "请先在 Photoshop 中打开一个文档后再运行此脚本。" },
    E002: { msg: "未选中任何图层", detail: "请在图层面板中选中至少一个图层后再运行此脚本。" },
    E201: { msg: "图层 '{layerName}' 重命名失败", detail: "该图层可能被锁定或为背景图层。请检查图层状态后重试。" },
    E203: { msg: "表达式与图层名不匹配", detail: "原始表达式无法匹配部分图层名，请检查表达式或图层名。" },
    E204: { msg: "序号参数无效", detail: "序号起始和步长必须为整数（可为负数）。" },
    E205: { msg: "新图层名不能为空", detail: "表达式生成的名称不能为空字符串。" },
    E206: { msg: "变量数量超过限制", detail: "图层名差异过大，变量数量超过 " + MAX_VARS + " 个。请减少选中图层数量。" },
    E999: { msg: "未知错误", detail: "发生了未预期的错误。请将错误信息反馈给开发者。" }
};

var _layerData = [];
var _originalSelectedIDs = [];
var _logFilePathCache = null;
var _originalLayerDataCache = null;
var _childrenLayerDataCache = null;

function posToVarChar(pos) {
    if (pos < 1 || pos > MAX_VARS) return null;
    return VAR_CHARS.charAt(pos - 1);
}

function varCharToPos(ch) {
    if (_varCharPosMap) {
        var pos = _varCharPosMap[ch];
        return pos !== undefined ? pos : -1;
    }
    var idx = VAR_CHARS.indexOf(ch);
    return idx >= 0 ? idx + 1 : -1;
}

function getErrorCodeInfo(code) {
    return ERROR_CODES[code] || ERROR_CODES.E999;
}

function formatErrorMessage(code, extra) {
    var info = getErrorCodeInfo(code);
    var msg = "[" + code + "] " + info.msg;
    if (extra) msg += "\n  附加信息: " + extra;
    msg += "\n  解决方案: " + info.detail.replace("{layerName}", extra || "");
    return msg;
}

function showError(code, extra) {
    alert(formatErrorMessage(code, extra), SCRIPT_NAME + " v" + SCRIPT_VERSION + " — 错误", true);
}

function getLogFilePath() {
    if (_logFilePathCache) return _logFilePathCache;
    try {
        var tempFolder = Folder.temp;
        if (tempFolder && tempFolder.exists) {
            _logFilePathCache = tempFolder.fsName + "/" + ERROR_LOG_FILE;
            return _logFilePathCache;
        }
    } catch (e) {}
    _logFilePathCache = Folder.desktop.fsName + "/" + ERROR_LOG_FILE;
    return _logFilePathCache;
}

function logError(code, extra) {
    var msg = formatErrorMessage(code, extra);
    var timestamp = new Date().toString();
    var logEntry = "[" + timestamp + "] " + msg + "\n---\n";
    try {
        var logFile = new File(getLogFilePath());
        logFile.open("a");
        logFile.write(logEntry);
        logFile.close();
    } catch (e) {}
}

function getSettingsFilePath() {
    try {
        var userData = Folder.userData;
        if (userData && userData.exists) return userData.fsName + "/" + SETTINGS_FILE;
    } catch (e) {}
    return Folder.temp.fsName + "/" + SETTINGS_FILE;
}

function loadSettings() {
    var settings = { excludeGroups: false, excludeLayers: false, seqPad: "0", reverse: false };
    try {
        var file = new File(getSettingsFilePath());
        if (file.exists) {
            file.open("r");
            var content = file.read();
            file.close();
            var lines = content.split("\n");
            for (var i = 0; i < lines.length; i++) {
                var eqIdx = lines[i].indexOf("=");
                if (eqIdx > 0) {
                    var key = lines[i].substring(0, eqIdx).replace(/^\s+|\s+$/g, "");
                    var val = lines[i].substring(eqIdx + 1).replace(/^\s+|\s+$/g, "");
                    if (key === "excludeGroups") settings.excludeGroups = (val === "true");
                    else if (key === "excludeLayers") settings.excludeLayers = (val === "true");
                    else if (key === "seqPad") settings.seqPad = val;
                    else if (key === "reverse") settings.reverse = (val === "true");
                }
            }
        }
    } catch (e) {}
    return settings;
}

function saveSettings(dlg) {
    try {
        var content = "excludeGroups=" + dlg.excludeGroupsCheck.value + "\n" +
                      "excludeLayers=" + dlg.excludeLayersCheck.value + "\n" +
                      "seqPad=" + dlg.seqPadInput.text + "\n" +
                      "reverse=" + dlg.reverseCheck.value;
        var file = new File(getSettingsFilePath());
        file.open("w");
        file.write(content);
        file.close();
    } catch (e) {}
}

function checkEnvironment() {
    if (!app.documents.length) { logError("E001"); showError("E001"); return false; }
    if (typeof ActionDescriptor === "undefined") { logError("E001"); showError("E001"); return false; }
    return true;
}

function getActiveLayerID() {
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    return executeActionGet(ref).getInteger(stringIDToTypeID("layerID"));
}

function getSelectedLayerIDs() {
    var ids = [];
    try {
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var desc = executeActionGet(ref);
        if (!desc.hasKey(stringIDToTypeID("targetLayers"))) {
            ids.push(getActiveLayerID());
            return ids;
        }
        var targetLayers = desc.getList(stringIDToTypeID("targetLayers"));
        for (var i = 0; i < targetLayers.count; i++) {
            var tRef = targetLayers.getReference(i);
            try { ids.push(tRef.getIdentifier()); } catch (e1) {
                try {
                    var idRef = new ActionReference();
                    idRef.putIndex(charIDToTypeID("Lyr "), tRef.getIndex());
                    ids.push(executeActionGet(idRef).getInteger(stringIDToTypeID("layerID")));
                } catch (e2) {
                    try {
                        var idRef2 = new ActionReference();
                        idRef2.putIndex(charIDToTypeID("Lyr "), tRef.getIndex() + 1);
                        ids.push(executeActionGet(idRef2).getInteger(stringIDToTypeID("layerID")));
                    } catch (e3) {}
                }
            }
        }
    } catch (e) {
        try { ids.push(getActiveLayerID()); } catch (e2) {}
    }
    var unique = [], seen = {};
    for (var j = 0; j < ids.length; j++) {
        if (!seen[ids[j]]) { seen[ids[j]] = true; unique.push(ids[j]); }
    }
    return unique;
}

function cacheLayerInfo(id) {
    var info = { id: id, name: "未知图层", isGroup: false, itemIndex: 0, newName: null };
    try {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), id);
        var desc = executeActionGet(ref);
        try { info.name = desc.getString(charIDToTypeID("Nm  ")); } catch (e) {}
        try { info.itemIndex = desc.getInteger(charIDToTypeID("ItmI")); } catch (e) {}
        try {
            var section = desc.getEnumerationValue(stringIDToTypeID("layerSection"));
            info.isGroup = (section === stringIDToTypeID("layerSectionStart"));
        } catch (e) {}
    } catch (e) {}
    return info;
}

function commonPrefix(strings) {
    if (strings.length === 0) return "";
    var prefix = strings[0];
    for (var i = 1; i < strings.length; i++) {
        while (strings[i].indexOf(prefix) !== 0) {
            prefix = prefix.substring(0, prefix.length - 1);
            if (prefix === "") return "";
        }
    }
    return prefix;
}

function commonSuffix(strings) {
    if (strings.length === 0) return "";
    var suffix = strings[0];
    for (var i = 1; i < strings.length; i++) {
        while (suffix.length > 0) {
            if (strings[i].length >= suffix.length &&
                strings[i].substring(strings[i].length - suffix.length) === suffix) {
                break;
            }
            suffix = suffix.substring(1);
        }
        if (suffix === "") return "";
    }
    return suffix;
}

function findLCS(strings) {
    if (strings.length === 0) return "";
    var shortest = strings[0];
    for (var i = 1; i < strings.length; i++) {
        if (strings[i].length < shortest.length) shortest = strings[i];
    }
    if (shortest.length === 0) return "";

    var best = "";
    for (var start = 0; start < shortest.length; start++) {
        for (var end = shortest.length; end > start + best.length; end--) {
            var sub = shortest.substring(start, end);
            if (sub.length <= best.length) break;
            var found = true;
            for (var i = 0; i < strings.length; i++) {
                if (strings[i].indexOf(sub) === -1) { found = false; break; }
            }
            if (found) { best = sub; break; }
        }
    }
    return best;
}

function buildPatternRecursive(strings, nextVar) {
    var allSame = true;
    for (var i = 1; i < strings.length; i++) {
        if (strings[i] !== strings[0]) { allSame = false; break; }
    }
    if (allSame) return { expression: strings[0], varCount: nextVar - 1 };

    var allEmpty = true;
    for (var i = 0; i < strings.length; i++) {
        if (strings[i] !== "") { allEmpty = false; break; }
    }
    if (allEmpty) return { expression: "", varCount: nextVar - 1 };

    var prefix = commonPrefix(strings);

    var remaining = [];
    for (var i = 0; i < strings.length; i++) {
        remaining.push(strings[i].substring(prefix.length));
    }
    var suffix = commonSuffix(remaining);

    var middle = [];
    for (var i = 0; i < strings.length; i++) {
        middle.push(strings[i].substring(prefix.length, strings[i].length - suffix.length));
    }

    var allMiddleSame = true;
    for (var i = 1; i < middle.length; i++) {
        if (middle[i] !== middle[0]) { allMiddleSame = false; break; }
    }

    if (prefix === "" && suffix === "" && !allMiddleSame) {
        var lcs = findLCS(strings);
        if (lcs !== "") {
            var parts = [];
            for (var i = 0; i < strings.length; i++) {
                var idx = strings[i].indexOf(lcs);
                parts.push({ before: strings[i].substring(0, idx), after: strings[i].substring(idx + lcs.length) });
            }

            var expression = "";
            var varCount = nextVar - 1;

            var hasBefore = false;
            for (var i = 0; i < parts.length; i++) {
                if (parts[i].before !== "") { hasBefore = true; break; }
            }
            if (hasBefore) {
                var beforeStrings = [];
                for (var i = 0; i < parts.length; i++) beforeStrings.push(parts[i].before);
                var beforeResult = buildPatternRecursive(beforeStrings, nextVar);
                if (beforeResult.error) return beforeResult;
                expression += beforeResult.expression;
                varCount = beforeResult.varCount;
                nextVar = varCount + 1;
            }

            expression += lcs;

            var hasAfter = false;
            for (var i = 0; i < parts.length; i++) {
                if (parts[i].after !== "") { hasAfter = true; break; }
            }
            if (hasAfter) {
                var afterStrings = [];
                for (var i = 0; i < parts.length; i++) afterStrings.push(parts[i].after);
                var afterResult = buildPatternRecursive(afterStrings, nextVar);
                if (afterResult.error) return afterResult;
                expression += afterResult.expression;
                varCount = afterResult.varCount;
            }

            return { expression: expression, varCount: varCount };
        } else {
            var vc = posToVarChar(nextVar);
            if (!vc) return { expression: "", varCount: nextVar, error: true };
            return { expression: "%" + vc, varCount: nextVar };
        }
    }

    var expression = prefix;
    var varCount = nextVar - 1;

    if (!allMiddleSame) {
        var middleResult = buildPatternRecursive(middle, nextVar);
        if (middleResult.error) return middleResult;
        expression += middleResult.expression;
        varCount = middleResult.varCount;
    } else if (middle.length > 0 && middle[0] !== "") {
        expression += middle[0];
    }

    expression += suffix;

    return { expression: expression, varCount: varCount };
}

function analyzePattern(names) {
    if (names.length === 0) return { expression: "", varCount: 0 };
    if (names.length === 1) return { expression: names[0], varCount: 0 };
    var result = buildPatternRecursive(names, 1);
    if (result.error) {
        return { expression: names[0], varCount: 0, error: true };
    }
    return { expression: result.expression, varCount: result.varCount };
}

function escapeRegexChar(c) {
    if (_escapeRegexMap && _escapeRegexMap[c]) return "\\" + c;
    if ("\\^$.*+?()[]{}|".indexOf(c) !== -1) return "\\" + c;
    return c;
}

function expressionToRegex(expr) {
    var regexStr = "^";
    var i = 0;
    while (i < expr.length) {
        if (expr.charAt(i) === "%") {
            if (i + 1 < expr.length && expr.charAt(i + 1) === "%") {
                regexStr += "%";
                i += 2;
            } else if (i + 1 < expr.length && expr.charAt(i + 1) === "d") {
                regexStr += "(\\d+)";
                i += 2;
            } else if (i + 1 < expr.length && VAR_CHARS.indexOf(expr.charAt(i + 1)) !== -1) {
                regexStr += "(.*?)";
                i += 2;
            } else {
                regexStr += escapeRegexChar("%");
                i++;
            }
        } else {
            regexStr += escapeRegexChar(expr.charAt(i));
            i++;
        }
    }
    regexStr += "$";
    return new RegExp(regexStr);
}

function extractVariables(name, expr, cachedRegex) {
    try {
        var regex = cachedRegex || expressionToRegex(expr);
        var match = name.match(regex);
        if (!match) return null;
        return match.slice(1);
    } catch (e) {
        return null;
    }
}

function padNumber(num, width) {
    if (width <= 0) return num.toString();
    var isNeg = num < 0;
    var s = Math.abs(num).toString();
    while (s.length < width) s = "0" + s;
    return isNeg ? "-" + s : s;
}

function generateNewName(newExpr, variables, seqNum, seqPad) {
    var result = "";
    var i = 0;
    while (i < newExpr.length) {
        if (newExpr.charAt(i) === "%") {
            if (i + 1 < newExpr.length && newExpr.charAt(i + 1) === "%") {
                result += "%";
                i += 2;
            } else if (i + 1 < newExpr.length && newExpr.charAt(i + 1) === "d") {
                result += padNumber(seqNum, seqPad);
                i += 2;
            } else if (i + 1 < newExpr.length) {
                var pos = varCharToPos(newExpr.charAt(i + 1));
                if (pos >= 1 && pos <= variables.length) {
                    result += variables[pos - 1];
                }
                i += 2;
            } else {
                result += "%";
                i++;
            }
        } else {
            result += newExpr.charAt(i);
            i++;
        }
    }
    return result;
}

function selectLayerByID(id) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), id);
    desc.putReference(charIDToTypeID("null"), ref);
    executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);
}

function cloneLayerData(arr) {
    var result = [];
    for (var i = 0; i < arr.length; i++) {
        var d = arr[i];
        result.push({ id: d.id, name: d.name, isGroup: d.isGroup, itemIndex: d.itemIndex, newName: null });
    }
    return result;
}

function addChildrenFromDOM(parentLayer, dataArr, seenIDs) {
    var layers = parentLayer.layers;
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var id = layer.id;
        if (!seenIDs[id]) {
            seenIDs[id] = true;
            dataArr.push({
                id: id,
                name: layer.name,
                isGroup: (layer.typename === "LayerSet"),
                itemIndex: 0,
                newName: null
            });
        }
        if (layer.typename === "LayerSet") {
            addChildrenFromDOM(layer, dataArr, seenIDs);
        }
    }
}

function updateCachesAfterApply() {
    var nameMap = {};
    for (var i = 0; i < _layerData.length; i++) {
        nameMap[_layerData[i].id] = _layerData[i].name;
    }
    if (_originalLayerDataCache) {
        for (var j = 0; j < _originalLayerDataCache.length; j++) {
            var n1 = nameMap[_originalLayerDataCache[j].id];
            if (n1 !== undefined) _originalLayerDataCache[j].name = n1;
        }
    }
    if (_childrenLayerDataCache) {
        for (var k = 0; k < _childrenLayerDataCache.length; k++) {
            var n2 = nameMap[_childrenLayerDataCache[k].id];
            if (n2 !== undefined) _childrenLayerDataCache[k].name = n2;
        }
    }
}

function rebuildLayerData(dlg) {
    var includeChildren = dlg.includeChildrenCheck.value;

    if (!includeChildren) {
        if (_originalLayerDataCache) {
            _layerData = cloneLayerData(_originalLayerDataCache);
        } else {
            _layerData = [];
            for (var r = 0; r < _originalSelectedIDs.length; r++) {
                _layerData.push(cacheLayerInfo(_originalSelectedIDs[r]));
            }
            _layerData.sort(function(a, b) { return b.itemIndex - a.itemIndex; });
            _originalLayerDataCache = cloneLayerData(_layerData);
        }

        dlg.origList.visible = false;
        dlg.origList.removeAll();
        for (var n = 0; n < _layerData.length; n++) {
            var rld = _layerData[n];
            var rprefix = rld.isGroup ? "[图层组] " : "[图层] ";
            dlg.origList.add("item", rprefix + rld.name);
        }
        dlg.origList.visible = true;

        regenerateExpression(dlg);
        return;
    }

    if (_childrenLayerDataCache) {
        _layerData = cloneLayerData(_childrenLayerDataCache);
    } else {
        if (!_originalLayerDataCache) {
            var tempData = [];
            for (var t = 0; t < _originalSelectedIDs.length; t++) {
                tempData.push(cacheLayerInfo(_originalSelectedIDs[t]));
            }
            tempData.sort(function(a, b) { return b.itemIndex - a.itemIndex; });
            _originalLayerDataCache = cloneLayerData(tempData);
        }

        _layerData = [];
        var seenIDs = {};

        for (var j = 0; j < _originalLayerDataCache.length; j++) {
            var orig = _originalLayerDataCache[j];
            if (!seenIDs[orig.id]) {
                seenIDs[orig.id] = true;
                _layerData.push({ id: orig.id, name: orig.name, isGroup: orig.isGroup, itemIndex: orig.itemIndex, newName: null });
            }

            if (orig.isGroup) {
                selectLayerByID(orig.id);
                var group = app.activeDocument.activeLayer;
                addChildrenFromDOM(group, _layerData, seenIDs);
            }
        }

        _childrenLayerDataCache = cloneLayerData(_layerData);
    }

    dlg.origList.visible = false;
    dlg.origList.removeAll();
    for (var p = 0; p < _layerData.length; p++) {
        var pld = _layerData[p];
        var pprefix = pld.isGroup ? "[图层组] " : "[图层] ";
        dlg.origList.add("item", pprefix + pld.name);
    }
    dlg.origList.visible = true;

    regenerateExpression(dlg);
}

function _lso_applyRename() {
    var doc = app.activeDocument;
    for (var i = 0; i < _layerData.length; i++) {
        var ld = _layerData[i];
        if (ld.excluded) continue;
        if (ld.newName === null || ld.newName === "" || ld.newName === ld.name) continue;
        try {
            selectLayerByID(ld.id);
            doc.activeLayer.name = ld.newName;
        } catch (e) {
            logError("E201", "图层 '" + ld.name + "' 重命名失败: " + e.message);
        }
    }
}

function regenerateExpression(dlg) {
    var excludeGroups = dlg.excludeGroupsCheck.value;
    var excludeLayers = dlg.excludeLayersCheck.value;

    var activeNames = [];
    for (var i = 0; i < _layerData.length; i++) {
        var ld = _layerData[i];
        var isExcluded = (excludeGroups && ld.isGroup) || (excludeLayers && !ld.isGroup);
        if (!isExcluded) {
            activeNames.push(ld.name);
        }
    }

    if (activeNames.length === 0) {
        dlg.origExpr.text = "";
        dlg.newExpr.text = "";
        updatePreview(dlg);
        return;
    }

    var pattern = analyzePattern(activeNames);
    if (pattern.error) {
        dlg.origExpr.text = activeNames[0];
        dlg.newExpr.text = activeNames[0];
    } else {
        dlg.origExpr.text = pattern.expression;
        dlg.newExpr.text = pattern.expression;
    }

    updatePreview(dlg);
}

function updatePreview(dlg) {
    try {
        var origExpr = dlg.origExpr.text;
        var newExpr = dlg.newExpr.text;
        var startStr = dlg.startInput.text;
        var stepStr = dlg.stepInput.text;
        var seqPadStr = dlg.seqPadInput.text;

        var start = parseInt(startStr, 10);
        var step = parseInt(stepStr, 10);
        var seqPad = parseInt(seqPadStr, 10) || 0;
        if (isNaN(start)) start = 1;
        if (isNaN(step)) step = 1;

        var n = _layerData.length;
        dlg.newList.visible = false;
        dlg.origList.visible = false;
        dlg.newList.removeAll();
        var reverse = dlg.reverseCheck.value;
        var excludeGroups = dlg.excludeGroupsCheck.value;
        var excludeLayers = dlg.excludeLayersCheck.value;

        var cachedRegex = null;
        try { cachedRegex = expressionToRegex(origExpr); } catch (e) {}

        var nonExcludedCount = 0;
        for (var k = 0; k < n; k++) {
            var ldK = _layerData[k];
            var isExclK = (excludeGroups && ldK.isGroup) || (excludeLayers && !ldK.isGroup);
            ldK.excluded = isExclK;
            if (!isExclK) nonExcludedCount++;
        }

        var seqIdx = 0;
        var GROUP_PREFIX = "[图层组] ";
        var LAYER_PREFIX = "[图层] ";
        for (var i = 0; i < n; i++) {
            var ld = _layerData[i];
            var prefix = ld.isGroup ? GROUP_PREFIX : LAYER_PREFIX;

            if (ld.excluded) {
                ld.newName = ld.name;
                var exclItem = dlg.newList.add("item", prefix + ld.name);
                exclItem.enabled = false;
                if (dlg.origList.items[i]) dlg.origList.items[i].enabled = false;
            } else {
                var variables = extractVariables(ld.name, origExpr, cachedRegex);
                var seqNum = reverse ? start + seqIdx * step : start + (nonExcludedCount - 1 - seqIdx) * step;
                seqIdx++;

                if (variables === null) {
                    ld.newName = null;
                    dlg.newList.add("item", prefix + "[不匹配]");
                } else {
                    ld.variables = variables;
                    var newName = generateNewName(newExpr, variables, seqNum, seqPad);
                    ld.newName = newName;
                    if (newName === "") {
                        dlg.newList.add("item", prefix + "[空名称]");
                    } else {
                        dlg.newList.add("item", prefix + newName);
                    }
                }
                if (dlg.origList.items[i]) dlg.origList.items[i].enabled = true;
            }
        }
        dlg.newList.visible = true;
        dlg.origList.visible = true;
    } catch (e) {}
}

function doValidate() {
    var hasMismatch = false;
    var hasEmpty = false;

    for (var i = 0; i < _layerData.length; i++) {
        var ld = _layerData[i];
        if (ld.excluded) continue;
        if (ld.newName === null) {
            hasMismatch = true;
        } else if (ld.newName === "") {
            hasEmpty = true;
        }
    }

    if (hasMismatch) {
        alert("原始表达式无法匹配部分图层名，请检查表达式。\n不匹配的图层在新图层名列表中显示为 [不匹配]。",
              SCRIPT_NAME + " — 表达式不匹配", true);
        return false;
    }

    if (hasEmpty) {
        alert("表达式生成了空名称，请修改新表达式。\n空名称的图层在新图层名列表中显示为 [空名称]。",
              SCRIPT_NAME + " — 名称为空", true);
        return false;
    }

    return true;
}

function doApply(dlg) {
    try {
        var start = parseInt(dlg.startInput.text, 10);
        var step = parseInt(dlg.stepInput.text, 10);
        if (isNaN(start) || isNaN(step)) {
            alert("序号起始和步长必须为整数。", SCRIPT_NAME + " — 参数错误", true);
            return false;
        }

        if (!doValidate()) return false;

        var hasChange = false;
        for (var j = 0; j < _layerData.length; j++) {
            if (_layerData[j].excluded) continue;
            if (_layerData[j].newName !== null && _layerData[j].newName !== _layerData[j].name) {
                hasChange = true;
                break;
            }
        }
        if (!hasChange) return true;

        var nameSet = {};
        var duplicates = [];
        for (var i = 0; i < _layerData.length; i++) {
            if (_layerData[i].excluded) continue;
            var nm = _layerData[i].newName;
            if (nm !== null && nm !== "") {
                if (nameSet[nm]) {
                    duplicates.push(nm);
                }
                nameSet[nm] = true;
            }
        }

        try {
            app.activeDocument.suspendHistory(SCRIPT_NAME, "_lso_applyRename()");
        } catch (e) {
            logError("E999", "重命名执行失败: " + e.message);
            showError("E999", "重命名执行失败: " + e.message);
            return false;
        }

        for (var i = 0; i < _layerData.length; i++) {
            if (_layerData[i].excluded) continue;
            if (_layerData[i].newName !== null && _layerData[i].newName !== _layerData[i].name) {
                _layerData[i].name = _layerData[i].newName;
            }
        }

        updateCachesAfterApply();

        if (duplicates.length > 0) {
            var uniqueDups = [];
            var seenDups = {};
            for (var k = 0; k < duplicates.length; k++) {
                if (!seenDups[duplicates[k]]) {
                    seenDups[duplicates[k]] = true;
                    uniqueDups.push(duplicates[k]);
                }
            }
            alert("重命名已完成，以下新图层名存在重复：\n" + uniqueDups.join("\n"),
                  SCRIPT_NAME + " — 同名提示", false);
        }

        return true;
    } catch (e) {
        logError("E999", "应用失败: " + e.message);
        showError("E999", "应用失败: " + e.message);
        return false;
    }
}

function refreshDialogAfterApply(dlg) {
    try {
        var excludeGroups = dlg.excludeGroupsCheck.value;
        var excludeLayers = dlg.excludeLayersCheck.value;

        var activeNames = [];
        for (var a = 0; a < _layerData.length; a++) {
            var ald = _layerData[a];
            var aExcl = (excludeGroups && ald.isGroup) || (excludeLayers && !ald.isGroup);
            if (!aExcl) activeNames.push(ald.name);
        }

        var pattern = activeNames.length > 0 ? analyzePattern(activeNames) : { expression: "", varCount: 0 };

        dlg.origList.visible = false;
        dlg.origList.removeAll();
        for (var i = 0; i < _layerData.length; i++) {
            var ld = _layerData[i];
            var prefix = ld.isGroup ? "[图层组] " : "[图层] ";
            var origItem = dlg.origList.add("item", prefix + ld.name);
            if (ld.excluded) origItem.enabled = false;
        }
        dlg.origList.visible = true;

        dlg.origExpr.text = pattern.expression;
        dlg.newExpr.text = pattern.expression;

        updatePreview(dlg);
    } catch (e) {}
}

function createDialog() {
    var dlg = new Window("dialog", SCRIPT_NAME + " v" + SCRIPT_VERSION);
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.margins = 16;
    dlg.spacing = 12;

    var listsGroup = dlg.add("group");
    listsGroup.orientation = "row";
    listsGroup.alignChildren = ["fill", "fill"];
    listsGroup.alignment = ["fill", "fill"];

    var origPanel = listsGroup.add("panel", undefined, "原始图层名");
    origPanel.alignment = ["fill", "fill"];
    origPanel.alignChildren = ["fill", "fill"];
    origPanel.margins = 10;
    dlg.origList = origPanel.add("listbox", undefined, [], { multiselect: false });
    dlg.origList.alignment = ["fill", "fill"];
    dlg.origList.preferredSize = [240, 200];

    var newPanel = listsGroup.add("panel", undefined, "新图层名");
    newPanel.alignment = ["fill", "fill"];
    newPanel.alignChildren = ["fill", "fill"];
    newPanel.margins = 10;
    dlg.newList = newPanel.add("listbox", undefined, [], { multiselect: false });
    dlg.newList.alignment = ["fill", "fill"];
    dlg.newList.preferredSize = [240, 200];

    var names = [];
    dlg.origList.visible = false;
    for (var i = 0; i < _layerData.length; i++) {
        var ld = _layerData[i];
        var prefix = ld.isGroup ? "[图层组] " : "[图层] ";
        names.push(ld.name);
        dlg.origList.add("item", prefix + ld.name);
    }
    dlg.origList.visible = true;

    var pattern = analyzePattern(names);
    if (pattern.error) {
        alert("图层名差异过大，变量数量超过 " + MAX_VARS + " 个。\n请减少选中图层数量或手动输入表达式。",
              SCRIPT_NAME + " — 变量过多", true);
        return null;
    }

    var excludeGroup = dlg.add("group");
    excludeGroup.orientation = "row";
    excludeGroup.alignChildren = ["left", "center"];
    dlg.excludeGroupsCheck = excludeGroup.add("checkbox", undefined, "排除图层组");
    dlg.excludeGroupsCheck.helpTip = "开启后不对图层组进行重命名";
    dlg.excludeLayersCheck = excludeGroup.add("checkbox", undefined, "排除图层");
    dlg.excludeLayersCheck.helpTip = "开启后不对普通图层进行重命名";
    dlg.includeChildrenCheck = excludeGroup.add("checkbox", undefined, "获取子对象");
    dlg.includeChildrenCheck.helpTip = "开启后将选中图层组的所有子对象加入列表";

    var origExprGroup = dlg.add("group");
    origExprGroup.orientation = "row";
    origExprGroup.alignChildren = ["left", "center"];
    origExprGroup.add("statictext", undefined, "原始表达式:");
    dlg.origExpr = origExprGroup.add("edittext", undefined, pattern.expression);
    dlg.origExpr.alignment = ["fill", "center"];
    dlg.origExpr.helpTip = "图层名模式，%1~%9 匹配变量部分（含空串和空格）";
    dlg.resetExprBtn = origExprGroup.add("button", undefined, "重置");
    dlg.resetExprBtn.preferredSize = [36, 22];
    dlg.resetExprBtn.maximumSize = [36, 22];
    dlg.resetExprBtn.alignment = ["right", "center"];
    dlg.resetExprBtn.helpTip = "根据当前图层名重新生成表达式";

    var newExprGroup = dlg.add("group");
    newExprGroup.orientation = "row";
    newExprGroup.alignChildren = ["left", "center"];
    newExprGroup.add("statictext", undefined, "新表达式:  ");
    dlg.newExpr = newExprGroup.add("edittext", undefined, pattern.expression);
    dlg.newExpr.alignment = ["fill", "center"];
    dlg.newExpr.helpTip = "修改此表达式生成新名称，%1~%9 引用原文本，%d 生成序号";

    var seqGroup = dlg.add("group");
    seqGroup.orientation = "row";
    seqGroup.alignChildren = ["left", "center"];
    seqGroup.add("statictext", undefined, "序号起始:");
    dlg.startInput = seqGroup.add("edittext", undefined, "1");
    dlg.startInput.preferredSize = [50, 25];
    dlg.startInput.helpTip = "序号从该数值开始（可为负数）";
    seqGroup.add("statictext", undefined, " 步长:");
    dlg.stepInput = seqGroup.add("edittext", undefined, "1");
    dlg.stepInput.preferredSize = [50, 25];
    dlg.stepInput.helpTip = "每次递增的数值（可为负数）";
    seqGroup.add("statictext", undefined, " 位数:");
    dlg.seqPadInput = seqGroup.add("edittext", undefined, "0");
    dlg.seqPadInput.preferredSize = [50, 25];
    dlg.seqPadInput.helpTip = "序号补零位数，0=不补零，3=补零为3位（如001）";
    dlg.reverseCheck = seqGroup.add("checkbox", undefined, "倒序");
    dlg.reverseCheck.helpTip = "开启后序号从最上方图层开始递增";

    var hintPanel = dlg.add("panel", undefined, "说明");
    hintPanel.orientation = "column";
    hintPanel.alignChildren = ["left", "top"];
    hintPanel.alignment = ["fill", "top"];
    hintPanel.margins = [12, 16, 12, 10];
    hintPanel.add("statictext", undefined, "新表达式中插入 %d 生产序号，插入 %% 生产 百分号");
    hintPanel.add("statictext", undefined, "%1~%9 = 变量（匹配任意文本，新表达式引用原文本）");

    var btnGroup = dlg.add("group");
    btnGroup.orientation = "row";
    btnGroup.alignment = ["fill", "bottom"];
    btnGroup.alignChildren = ["right", "center"];

    var githubBtn = btnGroup.add("button", undefined, "GitHub");
    githubBtn.preferredSize = [60, 28];
    githubBtn.alignment = ["left", "center"];
    githubBtn.helpTip = "复制项目 GitHub 链接";

    var spacer = btnGroup.add("statictext", undefined, "");
    spacer.alignment = ["fill", "center"];
    spacer.preferredSize = [0, 0];

    var okBtn = btnGroup.add("button", undefined, "确定");
    var applyBtn = btnGroup.add("button", undefined, "应用");
    var cancelBtn = btnGroup.add("button", undefined, "取消");

    githubBtn.onClick = function() {
        var url = "https://github.com/TheMorningCat/PhotoShopLayerBatchRename";
        try {
            var tempFile = new File(Folder.temp.fsName + "/ps_clipboard_url.txt");
            tempFile.open("w");
            tempFile.write(url);
            tempFile.close();
            if ($.os.indexOf("Windows") !== -1) {
                app.system('cmd.exe /c "<nul set /p=' + url + '|clip"');
            } else {
                app.system('echo -n "' + url + '" | pbcopy');
            }
            tempFile.remove();
            alert("GitHub 链接已复制到剪贴板：\n" + url, SCRIPT_NAME, false);
        } catch (e) {
            alert("GitHub 链接：\n" + url + "\n\n（自动复制失败，请手动复制）", SCRIPT_NAME, false);
        }
    };

    cancelBtn.onClick = function() {
        saveSettings(dlg);
        dlg.close(0);
    };

    applyBtn.onClick = function() {
        try {
            okBtn.text = "修改中";
            okBtn.enabled = false;
            applyBtn.enabled = false;
            dlg.update();
            if (doApply(dlg)) {
                saveSettings(dlg);
                refreshDialogAfterApply(dlg);
            }
        } catch (e) {
            alert("应用操作出现错误: " + e.message, SCRIPT_NAME + " — 错误", true);
        }
        okBtn.text = "确定";
        okBtn.enabled = true;
        applyBtn.enabled = true;
    };

    okBtn.onClick = function() {
        try {
            okBtn.text = "修改中";
            okBtn.enabled = false;
            applyBtn.enabled = false;
            dlg.update();
            if (doApply(dlg)) {
                saveSettings(dlg);
                dlg.close(1);
                return;
            }
        } catch (e) {
            alert("操作出现错误: " + e.message, SCRIPT_NAME + " — 错误", true);
        }
        okBtn.text = "确定";
        okBtn.enabled = true;
        applyBtn.enabled = true;
    };

    var savedSettings = loadSettings();
    dlg.excludeGroupsCheck.value = savedSettings.excludeGroups;
    dlg.excludeLayersCheck.value = savedSettings.excludeLayers;
    dlg.seqPadInput.text = savedSettings.seqPad;
    dlg.reverseCheck.value = savedSettings.reverse;

    if (savedSettings.excludeGroups || savedSettings.excludeLayers) {
        var activeNames = [];
        for (var si = 0; si < _layerData.length; si++) {
            var sld = _layerData[si];
            var sExcluded = (savedSettings.excludeGroups && sld.isGroup) || (savedSettings.excludeLayers && !sld.isGroup);
            if (!sExcluded) activeNames.push(sld.name);
        }
        if (activeNames.length > 0) {
            var sPattern = analyzePattern(activeNames);
            if (!sPattern.error) {
                dlg.origExpr.text = sPattern.expression;
                dlg.newExpr.text = sPattern.expression;
            }
        }
    }

    dlg.origList.onChange = function() {
        if (dlg.origList.selection !== null) {
            dlg.newList.selection = dlg.origList.selection.index;
        }
    };
    dlg.newList.onChange = function() {
        if (dlg.newList.selection !== null) {
            dlg.origList.selection = dlg.newList.selection.index;
        }
    };

    dlg.origExpr.onChanging = function() { updatePreview(dlg); };
    dlg.newExpr.onChanging = function() { updatePreview(dlg); };
    dlg.startInput.onChanging = function() { updatePreview(dlg); };
    dlg.stepInput.onChanging = function() { updatePreview(dlg); };
    dlg.seqPadInput.onChanging = function() { updatePreview(dlg); };

    dlg.origExpr.onChange = function() { updatePreview(dlg); };
    dlg.newExpr.onChange = function() { updatePreview(dlg); };
    dlg.startInput.onChange = function() { updatePreview(dlg); };
    dlg.stepInput.onChange = function() { updatePreview(dlg); };
    dlg.seqPadInput.onChange = function() { updatePreview(dlg); };
    dlg.reverseCheck.onClick = function() { updatePreview(dlg); };
    dlg.excludeGroupsCheck.onClick = function() { regenerateExpression(dlg); };
    dlg.excludeLayersCheck.onClick = function() { regenerateExpression(dlg); };
    dlg.resetExprBtn.onClick = function() { regenerateExpression(dlg); };
    dlg.includeChildrenCheck.onClick = function() { rebuildLayerData(dlg); };

    updatePreview(dlg);

    return dlg;
}

function main() {
    initLookupMaps();
    if (!checkEnvironment()) return;

    var selectedIDs = getSelectedLayerIDs();
    if (!selectedIDs || selectedIDs.length === 0) {
        logError("E002");
        showError("E002");
        return;
    }

    _originalSelectedIDs = selectedIDs.slice();

    _layerData = [];
    for (var i = 0; i < selectedIDs.length; i++) {
        _layerData.push(cacheLayerInfo(selectedIDs[i]));
    }

    _layerData.sort(function(a, b) { return b.itemIndex - a.itemIndex; });

    var dlg;
    try {
        dlg = createDialog();
    } catch (e) {
        logError("E999", "创建对话框失败: " + e.message);
        showError("E999", "创建对话框失败: " + e.message);
        return;
    }

    if (!dlg) return;

    dlg.show();
}

try { main(); }
catch (e) {
    var _errMsg = (e && e.message) ? e.message : "未知错误";
    var _errLine = (e && e.line) ? e.line : "未知";
    var _errFile = (e && e.fileName) ? e.fileName : "未知";
    logError("E999", _errMsg + " (行号: " + _errLine + ", 文件: " + _errFile + ")");
    showError("E999", _errMsg + " (行号: " + _errLine + ", 文件: " + _errFile + ")");
}
