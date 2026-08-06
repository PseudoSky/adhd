package com.adhd.apigen.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import io.javalin.Javalin;
import io.javalin.http.Context;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Iterator;
import java.util.Map;

/**
 * ApigenJavalinServer — the real HTTP server the java-javalin two-phase-spawn
 * plugin spawns as its phase-3 process (mirrors {@code apigen_python.flask_server}).
 *
 * <p>Route contract (byte-identical to every other host —
 * {@code apigen-plugin-py-flask/src/lib/plugin.ts} module doc comment):
 * <pre>
 *   POST &lt;route&gt;        body: {"data":{&lt;param&gt;:…}}  -&gt;  wire-encoded result, raw (no envelope wrapper)
 *   GET  /_meta/health  -&gt;  {"status":"ok","host":"&lt;ns&gt;"}
 * </pre>
 *
 * <p>Only the OUTER route (opId string -&gt; branch) is reflected into: a
 * SINGLE {@code Method} handle for {@code GeneratedDispatcher.dispatch(String,
 * JsonNode, ObjectMapper)}, resolved once at startup from {@code --classes-dir}
 * (the temp dir the two-phase-spawn plugin compiled the user source +
 * generated dispatcher into). Never reflects into the user's arbitrary
 * methods directly — those are called directly, by name, inside the
 * compiler-generated {@code GeneratedDispatcher} (DESIGN §2/§77-83).
 *
 * <p>Readiness protocol: emits {@code {"ready":true,"port":<n>}} on stdout
 * immediately after binding — {@code <n>} is the ACTUAL bound port (matters
 * when {@code --port 0} requests an OS-assigned ephemeral port), exactly like
 * every other host's two-phase-spawn readiness line.
 */
public final class ApigenJavalinServer {

  private ApigenJavalinServer() {}

  public static void main(String[] args) throws Exception {
    String planFile = null;
    String classesDir = null;
    int port = 8000;
    String host = "127.0.0.1";
    String namespace = "java";

    for (int i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--plan-file":
          planFile = args[++i];
          break;
        case "--classes-dir":
          classesDir = args[++i];
          break;
        case "--port":
          port = Integer.parseInt(args[++i]);
          break;
        case "--host":
          host = args[++i];
          break;
        case "--namespace":
          namespace = args[++i];
          break;
        default:
          System.err.println("ApigenJavalinServer: unknown arg " + args[i]);
          System.exit(2);
      }
    }

    if (planFile == null || classesDir == null) {
      System.err.println("ApigenJavalinServer: --plan-file and --classes-dir are required");
      System.exit(2);
      return;
    }

    ObjectMapper mapper = new ObjectMapper();
    mapper.registerModule(new JavaTimeModule());

    JsonNode plan = mapper.readTree(Files.readString(Paths.get(planFile)));
    JsonNode routes = plan.get("routes");
    if (routes == null) {
      System.err.println("ApigenJavalinServer: plan file missing \"routes\"");
      System.exit(1);
      return;
    }

    // Load the codegen-woven GeneratedDispatcher from the temp classes dir
    // the two-phase-spawn plugin compiled it into (parent-first delegation
    // shares JsonNode/ObjectMapper's own class identity with this JVM's
    // classpath — see class doc comment).
    URL classesUrl = new File(classesDir).toURI().toURL();
    URLClassLoader loader =
        new URLClassLoader(new URL[] {classesUrl}, ApigenJavalinServer.class.getClassLoader());
    Class<?> dispatcherClass = Class.forName("GeneratedDispatcher", true, loader);
    Method dispatchMethod =
        dispatcherClass.getMethod("dispatch", String.class, JsonNode.class, ObjectMapper.class);

    Javalin app = Javalin.create();

    final String healthHost = namespace;
    app.get("/_meta/health", (Context ctx) -> {
      ObjectNode body = mapper.createObjectNode();
      body.put("status", "ok");
      body.put("host", healthHost);
      ctx.contentType("application/json");
      ctx.result(mapper.writeValueAsString(body));
    });

    Iterator<Map.Entry<String, JsonNode>> fields = routes.fields();
    while (fields.hasNext()) {
      Map.Entry<String, JsonNode> entry = fields.next();
      String opId = entry.getKey();
      JsonNode routeSpec = entry.getValue();
      String route = routeSpec.get("route").asText();
      String verb = routeSpec.get("verb").asText();

      // Route contract (byte-identical to py-flask's do_GET/do_POST — see
      // apigen_python/flask_server.py): POST is registered for EVERY route
      // regardless of the projected verb (a route's do_POST handler doesn't
      // gate on entry.verb — see that file's do_POST doc comment), body
      // {"data":{...}}. GET is ADDITIONALLY registered only when project()
      // hoisted the op to GET (safe OR primitive-only-input — the SAME
      // canonical projector every host uses), reading params from the
      // query string instead of a JSON body.
      app.post(route, (Context ctx) -> {
        JsonNode body;
        try {
          body = mapper.readTree(ctx.body().isEmpty() ? "{}" : ctx.body());
        } catch (Exception e) {
          ctx.status(400);
          ctx.result(errorJson(mapper, "invalid_argument", "JSON parse error: " + e.getMessage()));
          return;
        }
        JsonNode data = body.has("data") ? body.get("data") : mapper.createObjectNode();
        dispatchAndRespond(ctx, mapper, dispatchMethod, opId, data);
      });

      if ("GET".equals(verb)) {
        app.get(route, (Context ctx) -> {
          ObjectNode data = mapper.createObjectNode();
          for (Map.Entry<String, java.util.List<String>> qp : ctx.queryParamMap().entrySet()) {
            java.util.List<String> values = qp.getValue();
            if (!values.isEmpty()) {
              data.put(qp.getKey(), values.get(0));
            }
          }
          dispatchAndRespond(ctx, mapper, dispatchMethod, opId, data);
        });
      }
    }

    app.start(host, port);
    int boundPort = app.port();

    // Readiness line — bounded-wait callers (java-javalin plugin.ts's
    // waitForReady) key off this exact JSON shape.
    System.out.println("{\"ready\":true,\"port\":" + boundPort + "}");
    System.out.flush();
  }

  private static void dispatchAndRespond(
      Context ctx, ObjectMapper mapper, Method dispatchMethod, String opId, JsonNode data) {
    try {
      JsonNode result = (JsonNode) dispatchMethod.invoke(null, opId, data, mapper);
      ctx.contentType("application/json");
      ctx.result(mapper.writeValueAsString(result));
    } catch (InvocationTargetException e) {
      Throwable cause = e.getCause() != null ? e.getCause() : e;
      ctx.status(500);
      ctx.result(errorJson(mapper, "internal", "dispatch error: " + cause.getMessage()));
    } catch (Exception e) {
      ctx.status(500);
      ctx.result(errorJson(mapper, "internal", "dispatch error: " + e.getMessage()));
    }
  }

  private static String errorJson(ObjectMapper mapper, String code, String message) {
    ObjectNode n = mapper.createObjectNode();
    n.put("code", code);
    n.put("message", message);
    try {
      return mapper.writeValueAsString(n);
    } catch (Exception e) {
      return "{\"code\":\"internal\",\"message\":\"error serialization failed\"}";
    }
  }
}
