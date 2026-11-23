import type { RepoView } from "@repoatlas/plugin-api";
import { describe, expect, it } from "vitest";
import {
  gradleDependencyGroups,
  isPlainGroupId,
  javaPrepare,
  pomDependencyGroups,
  readJavaProjectInfo,
} from "../../src/prepare/index.ts";
import { projectContext } from "./helpers.ts";

const POM = `<?xml version="1.0"?>
<!DOCTYPE project [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> <!ENTITY lol "lol"> ]>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>com.acme</groupId>
  <dependencyManagement><dependencies>
    <dependency><groupId>org.managed</groupId><artifactId>x</artifactId></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <!-- <dependency><groupId>commented.out</groupId></dependency> -->
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency>
    <dependency><groupId>\${project.groupId}</groupId><artifactId>self</artifactId></dependency>
    <dependency><groupId>&xxe;</groupId><artifactId>evil</artifactId></dependency>
    <dependency><groupId><![CDATA[cdata.group]]></groupId></dependency>
  </dependencies>
  <build><plugins><plugin>
    <dependencies><dependency><groupId>plugin.only</groupId></dependency></dependencies>
  </plugin></plugins></build>
</project>`;

describe("pomDependencyGroups", () => {
  it("reads literal dependency groupIds only", () => {
    expect(pomDependencyGroups(POM)).toEqual(["org.managed", "org.slf4j"]);
  });

  it("never throws on garbage and never expands entities", () => {
    for (const text of [
      "",
      "<",
      "<<<>>>",
      "<a><b></a>",
      "<!DOCTYPE",
      "<![CDATA[",
      "\u0000\u0001",
      "<dependency>".repeat(5000),
    ]) {
      expect(() => pomDependencyGroups(text)).not.toThrow();
    }
    expect(
      pomDependencyGroups(
        "<dependencies><dependency><groupId>&lol;</groupId></dependency></dependencies>",
      ),
    ).toEqual([]);
  });

  it("isPlainGroupId rejects placeholders and odd characters", () => {
    expect(isPlainGroupId("org.slf4j")).toBe(true);
    expect(isPlainGroupId("$" + "{x}")).toBe(false);
    expect(isPlainGroupId("a b")).toBe(false);
    expect(isPlainGroupId(".a")).toBe(false);
    expect(isPlainGroupId("")).toBe(false);
  });
});

describe("gradleDependencyGroups", () => {
  it("reads group:artifact:version strings and group = named arguments", () => {
    const script = [
      "plugins { id 'java' }",
      "dependencies {",
      '  implementation "org.slf4j:slf4j-api:2.0.9"',
      "  testImplementation('junit:junit:4.13')",
      '  api(group = "com.google.guava", name = "guava", version = "1")',
      "  compileOnly group: 'org.projectlombok', name: 'lombok'",
      '  // implementation "commented.out:x:1"',
      '  implementation "$' + '{libs.foo}"',
      '  classpath "not.a.dependency:x:1"',
      "}",
    ].join("\n");
    expect(gradleDependencyGroups(script)).toEqual([
      "com.google.guava",
      "junit",
      "org.projectlombok",
      "org.slf4j",
    ]);
  });

  it("never throws on garbage", () => {
    for (const text of ["", '"""', "implementation", "implementation '", "\u0000".repeat(10_000)]) {
      expect(() => gradleDependencyGroups(text)).not.toThrow();
    }
  });
});

describe("javaPrepare", () => {
  it("collects groups from nested manifests and returns plain JSON", async () => {
    const ctx = projectContext({
      "pom.xml": POM,
      "service/build.gradle": 'dependencies {\n  implementation "io.netty:netty-all:4"\n}',
      "service/src/main/java/A.java": "class A {}",
    });
    const info = await javaPrepare(ctx);
    expect(info.dependencyGroups).toEqual(["io.netty", "org.managed", "org.slf4j"]);
    expect(info.manifests).toEqual(["pom.xml", "service/build.gradle"]);
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
    expect(readJavaProjectInfo(info)).toEqual(info);
  });

  it("returns an empty result without manifests or when reading throws", async () => {
    expect(await javaPrepare(projectContext({ "A.java": "class A {}" }))).toEqual({
      dependencyGroups: [],
      manifests: [],
    });
    const ctx = projectContext({ "pom.xml": POM });
    const broken: RepoView = {
      ...ctx.repo,
      read: async () => {
        throw new Error("boom");
      },
    };
    expect(await javaPrepare({ ...ctx, repo: broken })).toEqual({
      dependencyGroups: [],
      manifests: [],
    });
  });

  it("readJavaProjectInfo tolerates missing or malformed info", () => {
    expect(readJavaProjectInfo(undefined)).toEqual({ dependencyGroups: [], manifests: [] });
    expect(readJavaProjectInfo({ dependencyGroups: [1, "a.b"], manifests: "x" })).toEqual({
      dependencyGroups: ["a.b"],
      manifests: [],
    });
  });
});
