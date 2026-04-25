(function (System, SystemJS) {
  (function (require, exports, module, __filename, __dirname, global, GLOBAL) {
    Object.defineProperty(exports, '__esModule', {
      value: true,
    });
    exports.default = void 0;

    let _react = _interopRequireDefault(require('react'));

    let _reactNative = require('react-native');

    let _expoGraphics = _interopRequireDefault(require('expo-graphics'));

    let _expoThree = _interopRequireWildcard(require('expo-three'));

    require('mapbox-gl');

    function _interopRequireWildcard(obj) {
      if (obj && obj.__esModule) {
        return obj;
      } else {
        let newObj = {};
        if (obj != null) {
          for (let key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              let desc =
                Object.defineProperty && Object.getOwnPropertyDescriptor
                  ? Object.getOwnPropertyDescriptor(obj, key)
                  : {};
              if (desc.get || desc.set) {
                Object.defineProperty(newObj, key, desc);
              } else {
                newObj[key] = obj[key];
              }
            }
          }
        }
        newObj.default = obj;
        return newObj;
      }
    }

    function _interopRequireDefault(obj) {
      return obj && obj.__esModule
        ? obj
        : {
            default: obj,
          };
    }

    function _classCallCheck(instance, Constructor) {
      if (!(instance instanceof Constructor)) {
        throw new TypeError('Cannot call a class as a function');
      }
    }

    function _defineProperties(target, props) {
      for (let i = 0; i < props.length; i++) {
        let descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ('value' in descriptor) descriptor.writable = true;
        Object.defineProperty(target, descriptor.key, descriptor);
      }
    }

    function _createClass(Constructor, protoProps, staticProps) {
      if (protoProps) _defineProperties(Constructor.prototype, protoProps);
      if (staticProps) _defineProperties(Constructor, staticProps);
      return Constructor;
    }

    function _possibleConstructorReturn(self, call) {
      if (call && (typeof call === 'object' || typeof call === 'function')) {
        return call;
      }
      return _assertThisInitialized(self);
    }

    function _assertThisInitialized(self) {
      if (self === void 0) {
        throw new ReferenceError(
          "this hasn't been initialised - super() hasn't been called"
        );
      }
      return self;
    }

    function _getPrototypeOf(o) {
      _getPrototypeOf = Object.setPrototypeOf
        ? Object.getPrototypeOf
        : function _getPrototypeOf(o) {
            return o.__proto__ || Object.getPrototypeOf(o);
          };
      return _getPrototypeOf(o);
    }

    function _inherits(subClass, superClass) {
      if (typeof superClass !== 'function' && superClass !== null) {
        throw new TypeError(
          'Super expression must either be null or a function'
        );
      }
      subClass.prototype = Object.create(superClass && superClass.prototype, {
        constructor: {
          value: subClass,
          writable: true,
          configurable: true,
        },
      });
      if (superClass) _setPrototypeOf(subClass, superClass);
    }

    function _setPrototypeOf(o, p) {
      _setPrototypeOf =
        Object.setPrototypeOf ||
        function _setPrototypeOf(o, p) {
          o.__proto__ = p;
          return o;
        };
      return _setPrototypeOf(o, p);
    }

    let App = (function (_React$Component) {
      _inherits(App, _React$Component);

      function App() {
        let _getPrototypeOf2;

        let _this;

        _classCallCheck(this, App);

        for (
          var _len = arguments.length, args = new Array(_len), _key = 0;
          _key < _len;
          _key++
        ) {
          args[_key] = arguments[_key];
        }

        _this = _possibleConstructorReturn(
          this,
          (_getPrototypeOf2 = _getPrototypeOf(App)).call.apply(
            _getPrototypeOf2,
            [this].concat(args)
          )
        );

        _this.onContextCreate = function _callee(gl) {
          let width, height, scale;
          return regeneratorRuntime.async(
            function _callee$(_context) {
              while (1) {
                switch ((_context.prev = _context.next)) {
                  case 0:
                    (width = gl.drawingBufferWidth),
                      (height = gl.drawingBufferHeight);
                    scale = _reactNative.PixelRatio.get();
                    _this.renderer = _expoThree.default.createRenderer({
                      gl: gl,
                    });

                    _this.renderer.setPixelRatio(scale);

                    _this.renderer.setSize(width / scale, height / scale);

                    _this.renderer.setClearColor(0x000000, 1.0);

                    _this.camera = new _expoThree.THREE.PerspectiveCamera(
                      50,
                      width / height,
                      0.1,
                      10000
                    );

                    _this.camera.position.set(5, 5, -5);

                    _this.camera.lookAt(0, 0, 0);

                    _context.next = 11;
                    return regeneratorRuntime.awrap(_this.setupSceneAsync());

                  case 11:
                  case 'end':
                    return _context.stop();
                }
              }
            },
            null,
            this
          );
        };

        _this.setupSceneAsync = function _callee2() {
          return regeneratorRuntime.async(
            function _callee2$(_context2) {
              while (1) {
                switch ((_context2.prev = _context2.next)) {
                  case 0:
                    _this.scene = new _expoThree.THREE.Scene();
                    _this.scene.background = new _expoThree.THREE.Color(
                      0x999999
                    );
                    _this.scene.fog = new _expoThree.THREE.FogExp2(
                      0xcccccc,
                      0.002
                    );

                    _this.scene.add(new _expoThree.THREE.GridHelper(5, 6));

                    _this.setupLights();

                    _context2.next = 7;
                    return regeneratorRuntime.awrap(_this.setupCubeAsync());

                  case 7:
                  case 'end':
                    return _context2.stop();
                }
              }
            },
            null,
            this
          );
        };

        _this.setupLights = function () {
          let directionalLightA = new _expoThree.THREE.DirectionalLight(
            0xffffff
          );
          directionalLightA.position.set(1, 1, 1);

          _this.scene.add(directionalLightA);

          let directionalLightB = new _expoThree.THREE.DirectionalLight(
            0xffeedd
          );
          directionalLightB.position.set(-1, -1, -1);

          _this.scene.add(directionalLightB);

          let ambientLight = new _expoThree.THREE.AmbientLight(0x222222);

          _this.scene.add(ambientLight);
        };

        _this.setupCubeAsync = function _callee3() {
          let someRemoteUrl, texture;
          return regeneratorRuntime.async(
            function _callee3$(_context3) {
              while (1) {
                switch ((_context3.prev = _context3.next)) {
                  case 0:
                    someRemoteUrl =
                      'https://www.biography.com/.image/t_share/MTE5NDg0MDU0ODczNDc0NTc1/ben-affleck-9176967-2-402.jpg';
                    _context3.next = 3;
                    return regeneratorRuntime.awrap(
                      _expoThree.default.loadAsync(someRemoteUrl)
                    );

                  case 3:
                    texture = _context3.sent;
                    _this.box = new _expoThree.THREE.Mesh(
                      new _expoThree.THREE.CubeGeometry(1, 1, 1),
                      new _expoThree.THREE.MeshPhongMaterial({
                        map: texture,
                      })
                    );

                    _this.scene.add(_this.box);

                  case 6:
                  case 'end':
                    return _context3.stop();
                }
              }
            },
            null,
            this
          );
        };

        _this.onResize = function (_ref) {
          let width = _ref.width,
            height = _ref.height;

          let scale = _reactNative.PixelRatio.get();

          _this.camera.aspect = width / height;

          _this.camera.updateProjectionMatrix();

          _this.renderer.setPixelRatio(scale);

          _this.renderer.setSize(width, height);
        };

        _this.onRender = function (delta) {
          _this.box.rotation.x = 0.3 * delta;
          _this.box.rotation.z = 0.6 * delta;

          _this.renderer.render(_this.scene, _this.camera);
        };

        return _this;
      }

      _createClass(App, [
        {
          key: 'componentWillMount',
          value: function componentWillMount() {
            _expoThree.THREE.suppressExpoWarnings(true);
          },
        },
        {
          key: 'render',
          value: function render() {
            return _react.default.createElement(_expoGraphics.default.View, {
              onContextCreate: this.onContextCreate,
              onRender: this.onRender,
              onResize: this.onResize,
            });
          },
        },
      ]);

      return App;
    })(_react.default.Component);

    exports.default = App;
  }).apply(__cjsWrapper.exports, __cjsWrapper.args);
})(System, System);
//# sourceURL=module://App.js.js!transpiled
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1vZHVsZTovL0FwcC5qcyJdLCJuYW1lcyI6WyJBcHAiLCJvbkNvbnRleHRDcmVhdGUiLCJnbCIsIndpZHRoIiwiZHJhd2luZ0J1ZmZlcldpZHRoIiwiaGVpZ2h0IiwiZHJhd2luZ0J1ZmZlckhlaWdodCIsInNjYWxlIiwiUGl4ZWxSYXRpbyIsImdldCIsInJlbmRlcmVyIiwiRXhwb1RIUkVFIiwiY3JlYXRlUmVuZGVyZXIiLCJzZXRQaXhlbFJhdGlvIiwic2V0U2l6ZSIsInNldENsZWFyQ29sb3IiLCJjYW1lcmEiLCJUSFJFRSIsIlBlcnNwZWN0aXZlQ2FtZXJhIiwicG9zaXRpb24iLCJzZXQiLCJsb29rQXQiLCJzZXR1cFNjZW5lQXN5bmMiLCJzY2VuZSIsIlNjZW5lIiwiYmFja2dyb3VuZCIsIkNvbG9yIiwiZm9nIiwiRm9nRXhwMiIsImFkZCIsIkdyaWRIZWxwZXIiLCJzZXR1cExpZ2h0cyIsInNldHVwQ3ViZUFzeW5jIiwiZGlyZWN0aW9uYWxMaWdodEEiLCJEaXJlY3Rpb25hbExpZ2h0IiwiZGlyZWN0aW9uYWxMaWdodEIiLCJhbWJpZW50TGlnaHQiLCJBbWJpZW50TGlnaHQiLCJzb21lUmVtb3RlVXJsIiwibG9hZEFzeW5jIiwidGV4dHVyZSIsImJveCIsIk1lc2giLCJDdWJlR2VvbWV0cnkiLCJNZXNoUGhvbmdNYXRlcmlhbCIsIm1hcCIsIm9uUmVzaXplIiwiYXNwZWN0IiwidXBkYXRlUHJvamVjdGlvbk1hdHJpeCIsIm9uUmVuZGVyIiwiZGVsdGEiLCJyb3RhdGlvbiIsIngiLCJ6IiwicmVuZGVyIiwic3VwcHJlc3NFeHBvV2FybmluZ3MiLCJSZWFjdCIsIkNvbXBvbmVudCJdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQTs7QUFDQTs7QUFFQTs7QUFDQTs7QUFDQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztJQUVxQkEsRzs7Ozs7Ozs7Ozs7Ozs7OztVQWVuQkMsZSxHQUFrQixpQkFBTUMsRUFBTjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFDWUMs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QUUsS0FBS2dELFFBRmpCO0FBR0UsUUFBQSxRQUFRLEVBQUUsS0FBS0g7QUFIakIsUUFERjtBQU9EOzs7O0VBYjhCVSxlQUFNQyxTIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCB7IFBpeGVsUmF0aW8gfSBmcm9tICdyZWFjdC1uYXRpdmUnO1xuXG5pbXBvcnQgRXhwb0dyYXBoaWNzIGZyb20gJ2V4cG8tZ3JhcGhpY3MnO1xuaW1wb3J0IEV4cG9USFJFRSwgeyBUSFJFRSB9IGZyb20gJ2V4cG8tdGhyZWUnO1xuaW1wb3J0ICdtYXBib3gtZ2wnO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBBcHAgZXh0ZW5kcyBSZWFjdC5Db21wb25lbnQge1xuICBjb21wb25lbnRXaWxsTW91bnQoKSB7XG4gICAgVEhSRUUuc3VwcHJlc3NFeHBvV2FybmluZ3ModHJ1ZSk7XG4gIH1cbiAgXG4gIHJlbmRlcigpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEV4cG9HcmFwaGljcy5WaWV3XG4gICAgICAgIG9uQ29udGV4dENyZWF0ZT17dGhpcy5vbkNvbnRleHRDcmVhdGV9XG4gICAgICAgIG9uUmVuZGVyPXt0aGlzLm9uUmVuZGVyfVxuICAgICAgICBvblJlc2l6ZT17dGhpcy5vblJlc2l6ZX1cbiAgICAgIC8+XG4gICAgKTtcbiAgfVxuXG4gIG9uQ29udGV4dENyZWF0ZSA9IGFzeW5jIGdsID0+IHtcbiAgICBjb25zdCB7IGRyYXdpbmdCdWZmZXJXaWR0aDogd2lkdGgsIGRyYXdpbmdCdWZmZXJIZWlnaHQ6IGhlaWdodCB9ID0gZ2w7XG4gICAgY29uc3Qgc2NhbGUgPSBQaXhlbFJhdGlvLmdldCgpO1xuXG4gICAgLy8gcmVuZGVyZXJcbiAgICB0aGlzLnJlbmRlcmVyID0gRXhwb1RIUkVFLmNyZWF0ZVJlbmRlcmVyKHtcbiAgICAgIGdsLFxuICAgIH0pO1xuICAgIHRoaXMucmVuZGVyZXIuc2V0UGl4ZWxSYXRpbyhzY2FsZSk7XG4gICAgdGhpcy5yZW5kZXJlci5zZXRTaXplKHdpZHRoIC8gc2NhbGUsIGhlaWdodCAvIHNjYWxlKTtcbiAgICB0aGlzLnJlbmRlcmVyLnNldENsZWFyQ29sb3IoMHgwMDAwMDAsIDEuMCk7XG5cbiAgICAvLy8gU3RhbmRhcmQgQ2FtZXJhXG4gICAgdGhpcy5jYW1lcmEgPSBuZXcgVEhSRUUuUGVyc3BlY3RpdmVDYW1lcmEoNTAsIHdpZHRoIC8gaGVpZ2h0LCAwLjEsIDEwMDAwKTtcbiAgICB0aGlzLmNhbWVyYS5wb3NpdGlvbi5zZXQoNSwgNSwgLTUpO1xuICAgIHRoaXMuY2FtZXJhLmxvb2tBdCgwLCAwLCAwKTtcblxuICAgIGF3YWl0IHRoaXMuc2V0dXBTY2VuZUFzeW5jKCk7XG4gIH07XG5cbiAgc2V0dXBTY2VuZUFzeW5jID0gYXN5bmMgKCkgPT4ge1xuICAgIC8vIHNjZW5lXG4gICAgdGhpcy5zY2VuZSA9IG5ldyBUSFJFRS5TY2VuZSgpO1xuXG4gICAgLy8gU3RhbmRhcmQgQmFja2dyb3VuZFxuICAgIHRoaXMuc2NlbmUuYmFja2dyb3VuZCA9IG5ldyBUSFJFRS5Db2xvcigweDk5OTk5OSk7XG4gICAgdGhpcy5zY2VuZS5mb2cgPSBuZXcgVEhSRUUuRm9nRXhwMigweGNjY2NjYywgMC4wMDIpO1xuXG4gICAgdGhpcy5zY2VuZS5hZGQobmV3IFRIUkVFLkdyaWRIZWxwZXIoNSwgNikpO1xuXG4gICAgdGhpcy5zZXR1cExpZ2h0cygpO1xuICAgIFxuICAgIGF3YWl0IHRoaXMuc2V0dXBDdWJlQXN5bmMoKTtcbiAgfTtcblxuICBzZXR1cExpZ2h0cyA9ICgpID0+IHtcbiAgICAvLyBsaWdodHNcbiAgICBjb25zdCBkaXJlY3Rpb25hbExpZ2h0QSA9IG5ldyBUSFJFRS5EaXJlY3Rpb25hbExpZ2h0KDB4ZmZmZmZmKTtcbiAgICBkaXJlY3Rpb25hbExpZ2h0QS5wb3NpdGlvbi5zZXQoMSwgMSwgMSk7XG4gICAgdGhpcy5zY2VuZS5hZGQoZGlyZWN0aW9uYWxMaWdodEEpO1xuXG4gICAgY29uc3QgZGlyZWN0aW9uYWxMaWdodEIgPSBuZXcgVEhSRUUuRGlyZWN0aW9uYWxMaWdodCgweGZmZWVkZCk7XG4gICAgZGlyZWN0aW9uYWxMaWdodEIucG9zaXRpb24uc2V0KC0xLCAtMSwgLTEpO1xuICAgIHRoaXMuc2NlbmUuYWRkKGRpcmVjdGlvbmFsTGlnaHRCKTtcblxuICAgIGNvbnN0IGFtYmllbnRMaWdodCA9IG5ldyBUSFJFRS5BbWJpZW50TGlnaHQoMHgyMjIyMjIpO1xuICAgIHRoaXMuc2NlbmUuYWRkKGFtYmllbnRMaWdodCk7XG4gIH07XG5cblxuICBzZXR1cEN1YmVBc3luYyA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzb21lUmVtb3RlVXJsID1cbiAgICAgICdodHRwczovL3d3dy5iaW9ncmFwaHkuY29tLy5pbWFnZS90X3NoYXJlL01URTVORGcwTURVME9EY3pORGMwTlRjMS9iZW4tYWZmbGVjay05MTc2OTY3LTItNDAyLmpwZyc7XG4gICAgY29uc3QgdGV4dHVyZSA9IGF3YWl0IEV4cG9USFJFRS5sb2FkQXN5bmMoc29tZVJlbW90ZVVybCk7XG4gICAgdGhpcy5ib3ggPSBuZXcgVEhSRUUuTWVzaChcbiAgICAgIG5ldyBUSFJFRS5DdWJlR2VvbWV0cnkoMSwgMSwgMSksXG4gICAgICBuZXcgVEhSRUUuTWVzaFBob25nTWF0ZXJpYWwoeyBtYXA6IHRleHR1cmUgfSlcbiAgICApO1xuICAgIHRoaXMuc2NlbmUuYWRkKHRoaXMuYm94KTtcbiAgfTtcblxuICBvblJlc2l6ZSA9ICh7IHdpZHRoLCBoZWlnaHQgfSkgPT4ge1xuICAgIGNvbnN0IHNjYWxlID0gUGl4ZWxSYXRpby5nZXQoKTtcblxuICAgIHRoaXMuY2FtZXJhLmFzcGVjdCA9IHdpZHRoIC8gaGVpZ2h0O1xuICAgIHRoaXMuY2FtZXJhLnVwZGF0ZVByb2plY3Rpb25NYXRyaXgoKTtcbiAgICB0aGlzLnJlbmRlcmVyLnNldFBpeGVsUmF0aW8oc2NhbGUpO1xuICAgIHRoaXMucmVuZGVyZXIuc2V0U2l6ZSh3aWR0aCwgaGVpZ2h0KTtcbiAgfTtcblxuICBvblJlbmRlciA9IGRlbHRhID0+IHtcbiAgICB0aGlzLmJveC5yb3RhdGlvbi54ID0gMC4zICogZGVsdGE7XG4gICAgdGhpcy5ib3gucm90YXRpb24ueiA9IDAuNiAqIGRlbHRhO1xuXG4gICAgdGhpcy5yZW5kZXJlci5yZW5kZXIodGhpcy5zY2VuZSwgdGhpcy5jYW1lcmEpO1xuICB9O1xufVxuIl0sImZpbGUiOiJtb2R1bGU6Ly9BcHAuanMuanMhdHJhbnNwaWxlZCJ9
