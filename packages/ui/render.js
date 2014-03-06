
UI.Component.instantiate = function (parent) {
  var kind = this;

  // check arguments
  if (UI.isComponent(kind)) {
    if (kind.isInited)
      throw new Error("A component kind is required, not an instance");
  } else {
    throw new Error("Expected Component kind");
  }

  var inst = kind.extend(); // XXX args go here
  inst.isInited = true;

  // XXX messy to define this here
  inst.templateInstance = {
    findAll: function (selector) {
      // XXX check that `.dom` exists here?
      return inst.dom.$(selector);
    },
    find: function (selector) {
      var result = this.findAll(selector);
      return result[0] || null;
    },
    firstNode: null,
    lastNode: null,
    data: null,
    __component__: inst
  };

  inst.parent = (parent || null);

  if (inst.init)
    inst.init();

  if (inst.created) {
    updateTemplateInstance(inst);
    inst.created.call(inst.templateInstance);
  }

  return inst;
};

UI.Component.render = function () {
  return null;
};


// Takes a reactive function (call it `inner`) and returns a reactive function
// `outer` which is equivalent except in its reactive behavior.  Specifically,
// `outer` has the following two special properties:
//
// 1. Isolation:  An invocation of `outer()` only invalidates its context
//    when the value of `inner()` changes.  For example, `inner` may be a
//    function that gets one or more Session variables and calculates a
//    true/false value.  `outer` blocks invalidation signals caused by the
//    Session variables changing and sends a signal out only when the value
//    changes between true and false (in this example).  The value can be
//    of any type, and it is compared with `===` unless an `equals` function
//    is provided.
//
// 2. Value Sharing:  The `outer` function returned by `emboxValue` can be
//    shared between different contexts, for example by assigning it to an
//    object as a method that can be accessed at any time, such as by
//    different templates or different parts of a template.  No matter
//    how many times `outer` is called, `inner` is only called once until
//    it changes.  The most recent value is stored internally.
//
// Conceptually, an emboxed value is much like a Session variable which is
// kept up to date by an autorun.  Session variables provide storage
// (value sharing) and they don't notify their listeners unless a value
// actually changes (isolation).  The biggest difference is that such an
// autorun would never be stopped, and the Session variable would never be
// deleted even if it wasn't used any more.  An emboxed value, on the other
// hand, automatically stops computing when it's not being used, and starts
// again when called from a reactive context.  This means that when it stops
// being used, it can be completely garbage-collected.
//
// If a non-function value is supplied to `emboxValue` instead of a reactive
// function, then `outer` is still a function but it simply returns the value.
//
UI.emboxValue = function (funcOrValue, equals) {
  if (typeof funcOrValue === 'function') {
    var func = funcOrValue;

    var curResult = null;
    // There's one shared Dependency and Computation for all callers of
    // our box function.  It gets kicked off if necessary, and when
    // there are no more dependents, it gets stopped to avoid leaking
    // memory.
    var resultDep = null;
    var computation = null;

    return function () {
      if (! computation) {
        if (! Deps.active) {
          // Not in a reactive context.  Just call func, and don't start a
          // computation if there isn't one running already.
          return func();
        }

        // No running computation, so kick one off.  Since this computation
        // will be shared, avoid any association with the current computation
        // by using `Deps.nonreactive`.
        resultDep = new Deps.Dependency;

        computation = Deps.nonreactive(function () {
          return Deps.autorun(function (c) {
            var oldResult = curResult;
            curResult = func();
            if (! c.firstRun) {
              if (! (equals ? equals(curResult, oldResult) :
                     curResult === oldResult))
                resultDep.changed();
            }
          });
        });
      }

      if (Deps.active) {
        var isNew = resultDep.depend();
        if (isNew) {
          // For each new dependent, schedule a task for after that dependent's
          // invalidation time and the subsequent flush. The task checks
          // whether the computation should be torn down.
          Deps.onInvalidate(function () {
            if (resultDep && ! resultDep.hasDependents()) {
              Deps.afterFlush(function () {
                // use a second afterFlush to bump ourselves to the END of the
                // flush, after computation re-runs have had a chance to
                // re-establish their connections to our computation.
                Deps.afterFlush(function () {
                  if (resultDep && ! resultDep.hasDependents()) {
                    computation.stop();
                    computation = null;
                    resultDep = null;
                  }
                });
              });
            }
          });
        }
      }

      return curResult;
    };

  } else {
    var value = funcOrValue;
    var result = function () {
      return value;
    };
    result._isEmboxedConstant = true;
    return result;
  }
};


////////////////////////////////////////

UI.insert = function (renderedTemplate, parentElement, nextNode) {
  if (! renderedTemplate.dom)
    throw new Error("Expected template rendered with UI.render");

  UI.DomRange.insert(renderedTemplate.dom, parentElement, nextNode);
};

// Insert a DOM node or DomRange into a DOM element or DomRange.
//
// One of three things happens depending on what needs to be inserted into what:
// - `range.add` (anything into DomRange)
// - `UI.DomRange.insert` (DomRange into element)
// - `elem.insertBefore` (node into element)
//
// The optional `before` argument is an existing node or id to insert before in
// the parent element or DomRange.
var insert = function (nodeOrRange, parent, before) {
  if (! parent)
    throw new Error("Materialization parent required");

  if (parent instanceof UI.DomRange) {
    parent.add(nodeOrRange, before);
  } else if (nodeOrRange instanceof UI.DomRange) {
    // parent is an element; inserting a range
    UI.DomRange.insert(nodeOrRange, parent, before);
  } else {
    // parent is an element; inserting an element
    parent.insertBefore(nodeOrRange, before || null); // `null` for IE
  }
};

// Update attributes on `elem` to the dictionary `attrs`, using the
// dictionary of existing `handlers` if provided.
//
// Values in the `attrs` dictionary are in pseudo-DOM form -- a string,
// CharRef, or array of strings and CharRefs -- but they are passed to
// the AttributeHandler in string form.
var updateAttributes = function(elem, newAttrs, handlers) {

  if (handlers) {
    for (var k in handlers) {
      if (! newAttrs.hasOwnProperty(k)) {
        // remove attributes (and handlers) for attribute names
        // that don't exist as keys of `newAttrs` and so won't
        // be visited when traversing it.  (Attributes that
        // exist in the `newAttrs` object but are `null`
        // are handled later.)
        var handler = handlers[k];
        var oldValue = handler.value;
        handler.value = null;
        handler.update(elem, oldValue, null);
        delete handlers[k];
      }
    }
  }

  for (var k in newAttrs) {
    var handler = null;
    var oldValue;
    var value = newAttrs[k];
    if ((! handlers) || (! handlers.hasOwnProperty(k))) {
      if (value !== null) {
        // make new handler
        handler = makeAttributeHandler(elem, k, value);
        if (handlers)
          handlers[k] = handler;
        oldValue = null;
      }
    } else {
      handler = handlers[k];
      oldValue = handler.value;
    }
    if (handler && oldValue !== value) {
      handler.value = value;
      handler.update(elem, oldValue, value);
      if (value === null)
        delete handlers[k];
    }
  }
};

UI.render = function (kind, parentComponent) {
  if (kind.isInited)
    throw new Error("Can't render component instance, only component kind");
  var inst = kind.instantiate(parentComponent);

  var content = (inst.render && inst.render());

  var range = new UI.DomRange;
  inst.dom = range;
  range.component = inst;

  materialize(content, range, null, inst);

  range.removed = function () {
    inst.isDestroyed = true;
    if (inst.destroyed) {
      updateTemplateInstance(inst);
      inst.destroyed.call(inst.templateInstance);
    }
  };

  return inst;
};

UI.renderWithData = function (kind, data, parentComponent) {
  if (! UI.isComponent(kind))
    throw new Error("Component required here");
  if (kind.isInited)
    throw new Error("Can't render component instance, only component kind");
  if (typeof data === 'function')
    throw new Error("Data argument can't be a function");

  return UI.render(kind.extend({data: function () { return data; }}),
                   parentComponent);
};

var contentEquals = function (a, b) {
  if (a instanceof HTML.Raw) {
    return (b instanceof HTML.Raw) && (a.value === b.value);
  } else if (a == null) {
    return (b == null);
  } else {
    return (a === b) &&
      ((typeof a === 'number') || (typeof a === 'boolean') ||
       (typeof a === 'string'));
  }
};

UI.InTemplateScope = function (tmplInstance, content) {
  if (! (this instanceof UI.InTemplateScope))
    // called without `new`
    return new UI.InTemplateScope(tmplInstance, content);

  var parentPtr = tmplInstance.parent;
  if (parentPtr.__isTemplateWith)
    parentPtr = parentPtr.parent;

  this.parentPtr = parentPtr;
  this.content = content;
};

UI.InTemplateScope.prototype.toHTML = function (parentComponent) {
  return UI.toHTML(this.content, this.parentPtr);
};

UI.InTemplateScope.prototype.toText = function (textMode, parentComponent) {
  return UI.toText(this.content, textMode, this.parentPtr);
};

// Convert the pseudoDOM `node` into reactive DOM nodes and insert them
// into the element or DomRange `parent`, before the node or id `before`.
var materialize = function (node, parent, before, parentComponent) {
  // XXX should do more error-checking for the case where user is supplying the tags.
  // For example, check that CharRef has `html` and `str` properties and no content.
  // Check that Comment has a single string child and no attributes.  Etc.

  if (node == null) {
    // null or undefined.
    // do nothinge.
  } else if ((typeof node === 'string') || (typeof node === 'boolean') || (typeof node === 'number')) {
    node = String(node);
    insert(document.createTextNode(node), parent, before);
  } else if (node instanceof Array) {
    for (var i = 0; i < node.length; i++)
      materialize(node[i], parent, before, parentComponent);
  } else if (typeof node === 'function') {

    var range = new UI.DomRange;
    var lastContent = null;
    var rangeUpdater = Deps.autorun(function (c) {
      var content = node();
      // normalize content a little, for easier comparison
      if (HTML.isNully(content))
        content = null;
      else if ((content instanceof Array) && content.length === 1)
        content = content[0];

      // update if content is different from last time
      if (! contentEquals(content, lastContent)) {
        lastContent = content;

        if (! c.firstRun)
          range.removeAll();

        Deps.nonreactive(function () {
          materialize(content, range, null, parentComponent);
        });
      }
    });
    range.removed = function () {
      rangeUpdater.stop();
    };
    insert(range, parent, before);
  } else if (node instanceof HTML.Tag) {
    var tagName = node.tagName;
    var elem;
    if (HTML.isKnownSVGElement(tagName) && document.createElementNS) {
      elem = document.createElementNS('http://www.w3.org/2000/svg', tagName);
    } else {
      elem = document.createElement(node.tagName);
    }

    var rawAttrs = node.attrs;
    var children = node.children;
    if (node.tagName === 'textarea') {
      rawAttrs = (rawAttrs || {});
      rawAttrs.value = children;
      children = [];
    };

    if (rawAttrs) {
      var attrUpdater = Deps.autorun(function (c) {
        if (! c.handlers)
          c.handlers = {};

        try {
          var attrs = HTML.evaluateAttributes(rawAttrs, parentComponent);
          var stringAttrs = {};
          if (attrs) {
            for (var k in attrs) {
              stringAttrs[k] = UI.toText(attrs[k], UI.TEXTMODE.STRING,
                                           parentComponent);
            }
            updateAttributes(elem, stringAttrs, c.handlers);
          }
        } catch (e) {
          reportUIException(e);
        }
      });
      UI.DomBackend.onRemoveElement(elem, function () {
        attrUpdater.stop();
      });
    }
    materialize(children, elem, null, parentComponent);

    insert(elem, parent, before);
  } else if (typeof node.instantiate === 'function') {
    // component
    var instance = UI.render(node, parentComponent);

    insert(instance.dom, parent, before);
  } else if (node instanceof HTML.CharRef) {
    insert(document.createTextNode(node.str), parent, before);
  } else if (node instanceof HTML.Comment) {
    insert(document.createComment(node.sanitizedValue), parent, before);
  } else if (node instanceof HTML.Raw) {
    // Get an array of DOM nodes by using the browser's HTML parser
    // (like innerHTML).
    var htmlNodes = UI.DomBackend.parseHTML(node.value);
    for (var i = 0; i < htmlNodes.length; i++)
      insert(htmlNodes[i], parent, before);
  } else if (Package['html-tools'] && (node instanceof Package['html-tools'].HTMLTools.Special)) {
    throw new Error("Can't materialize Special tag, it's just an intermediate rep");
  } else if (node instanceof UI.InTemplateScope) {
    materialize(node.content, parent, before, node.parentPtr);
  } else {
    // can't get here
    throw new Error("Unexpected node in htmljs: " + node);
  }
};



// XXX figure out the right names, and namespace, for these.
// for example, maybe some of them go in the HTML package.
UI.materialize = materialize;

UI.body = UI.Component.extend({
  kind: 'body',
  contentParts: [],
  render: function () {
    return this.contentParts;
  },
  // XXX revisit how body works.
  INSTANTIATED: false
});

UI.block = function (renderFunc) {
  return UI.Component.extend({ render: renderFunc });
};

UI.toRawText = function (content, parentComponent) {
  return UI.toText(content, UI.TEXTMODE.STRING, parentComponent);
};

UI.toHTML = function (node, parentComponent) {
  if (node == null) {
    // null or undefined
    return '';
  } else if ((typeof node === 'string') || (typeof node === 'boolean') || (typeof node === 'number')) {
    // string; escape special chars
    return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  } else if (node instanceof Array) {
    // array
    var parts = [];
    for (var i = 0; i < node.length; i++)
      parts.push(UI.toHTML(node[i], parentComponent));
    return parts.join('');
  } else if (typeof node.instantiate === 'function') {
    // component
    var instance = node.instantiate(parentComponent || null);
    var content = instance.render('STATIC');
    // recurse with a new value for parentComponent
    return UI.toHTML(content, instance);
  } else if (typeof node === 'function') {
    return UI.toHTML(node(), parentComponent);
  } else if (node.toHTML) {
    // Tag or something else
    return node.toHTML(parentComponent);
  } else {
    throw new Error("Expected tag, string, array, component, null, undefined, or " +
                    "object with a toHTML method; found: " + node);
  }
};

HTML.Comment.prototype.toHTML = function () {
  return '<!--' + this.sanitizedValue + '-->';
};

HTML.CharRef.prototype.toHTML = function () {
  return this.html;
};

HTML.Raw.prototype.toHTML = function () {
  return this.value;
};

HTML.Tag.prototype.toHTML = function (parentComponent) {
  var attrStrs = [];
  var attrs = this.evaluateAttributes(parentComponent);
  if (attrs) {
    for (var k in attrs) {
      var v = UI.toText(attrs[k], UI.TEXTMODE.ATTRIBUTE, parentComponent);
      attrStrs.push(' ' + k + '="' + v + '"');
    }
  }

  var tagName = this.tagName;
  var startTag = '<' + tagName + attrStrs.join('') + '>';

  var childStrs = [];
  var content;
  if (tagName === 'textarea') {
    for (var i = 0; i < this.children.length; i++)
      childStrs.push(UI.toText(this.children[i], UI.TEXTMODE.RCDATA, parentComponent));

    content = childStrs.join('');
    if (content.slice(0, 1) === '\n')
      // TEXTAREA will absorb a newline, so if we see one, add
      // another one.
      content = '\n' + content;

  } else {
    for (var i = 0; i < this.children.length; i++)
      childStrs.push(UI.toHTML(this.children[i], parentComponent));

    content = childStrs.join('');
  }

  var result = startTag + content;

  if (this.children.length || ! HTML.isVoidElement(tagName)) {
    // "Void" elements like BR are the only ones that don't get a close
    // tag in HTML5.  They shouldn't have contents, either, so we could
    // throw an error upon seeing contents here.
    result += '</' + tagName + '>';
  }

  return result;
};

UI.TEXTMODE = {
  ATTRIBUTE: 1,
  RCDATA: 2,
  STRING: 3
};

UI.toText = function (node, textMode, parentComponent) {
  if (node == null) {
    // null or undefined
    return '';
  } else if ((typeof node === 'string') || (typeof node === 'boolean') || (typeof node === 'number')) {
    node = String(node);
    // string
    if (textMode === UI.TEXTMODE.STRING) {
      return node;
    } else if (textMode === UI.TEXTMODE.RCDATA) {
      return node.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    } else if (textMode === UI.TEXTMODE.ATTRIBUTE) {
      // escape `&` and `"` this time, not `&` and `<`
      return node.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    } else {
      throw new Error("Unknown TEXTMODE: " + textMode);
    }
  } else if (node instanceof Array) {
    // array
    var parts = [];
    for (var i = 0; i < node.length; i++)
      parts.push(UI.toText(node[i], textMode, parentComponent));
    return parts.join('');
  } else if (typeof node === 'function') {
    return UI.toText(node(), textMode, parentComponent);
  } else if (typeof node.instantiate === 'function') {
    // component
    var instance = node.instantiate(parentComponent || null);
    var content = instance.render('STATIC');
    return UI.toText(content, textMode, instance);
  } else if (node.toText) {
    // Something else
    return node.toText(textMode, parentComponent);
  } else {
    throw new Error("Expected tag, string, array, component, null, undefined, or " +
                    "object with a toText method; found: " + node);
  }

};

HTML.Raw.prototype.toText = function () {
  return this.value;
};

// used when including templates within {{#markdown}}
HTML.Tag.prototype.toText = function (textMode, parentComponent) {
  if (textMode === UI.TEXTMODE.STRING)
    // stringify the tag as HTML, then convert to text
    return UI.toText(this.toHTML(parentComponent), textMode);
  else
    throw new Error("Can't insert tags in attributes or TEXTAREA elements");
};

HTML.CharRef.prototype.toText = function (textMode) {
  if (textMode === UI.TEXTMODE.STRING)
    return this.str;
  else if (textMode === UI.TEXTMODE.RCDATA)
    return this.html;
  else if (textMode === UI.TEXTMODE.ATTRIBUTE)
    return this.html;
  else
    throw new Error("Unknown TEXTMODE: " + textMode);
};