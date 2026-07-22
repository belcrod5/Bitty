import assert from "node:assert/strict";
import http from "node:http";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkspaceFilesService,
  WorkspaceFilesError,
} from "../src/workspace-files.mjs";

async function withTempDir(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-upload-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("saves a file in the selected directory without overwriting", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const targetDirectory = path.join(projectRoot, "assets");
    await mkdir(targetDirectory, { recursive: true });
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });

    const result = await service.saveFile({
      rootDir: "project",
      targetDirectory: "project/assets",
      fileName: "sample.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello"),
    });

    assert.equal(result.path, "project/assets/sample.txt");
    assert.equal(result.directory, "project/assets");
    assert.equal(result.size, 5);
    assert.equal(await readFile(path.join(targetDirectory, "sample.txt"), "utf8"), "hello");

    await assert.rejects(
      service.saveFile({
        rootDir: "project",
        targetDirectory: "project/assets",
        fileName: "sample.txt",
        mimeType: "text/plain",
        data: Buffer.from("replacement"),
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "file_exists"
    );
  });
});

test("rejects invalid names, oversized files, and directories outside the selected root", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const outsideDirectory = path.join(workspaceRoot, "outside");
    await mkdir(projectRoot);
    await mkdir(outsideDirectory);
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 4,
    });

    await assert.rejects(
      service.saveFile({
        rootDir: "project",
        targetDirectory: "project",
        fileName: "../escape.txt",
        data: Buffer.from("x"),
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "invalid_file_name"
    );
    await assert.rejects(
      service.saveFile({
        rootDir: "project",
        targetDirectory: "project",
        fileName: "large.txt",
        data: Buffer.from("large"),
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "file_too_large"
    );
    await assert.rejects(
      service.saveFile({
        rootDir: "project",
        targetDirectory: "outside",
        fileName: "escape.txt",
        data: Buffer.from("x"),
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "target_directory_invalid"
    );
  });
});

test("rejects a target directory that enters an outside symlink", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const outsideDirectory = path.join(workspaceRoot, "outside");
    await mkdir(projectRoot);
    await mkdir(outsideDirectory);
    await symlink(await realpath(outsideDirectory), path.join(projectRoot, "linked"));
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });

    await assert.rejects(
      service.saveFile({
        rootDir: "project",
        targetDirectory: "project/linked",
        fileName: "escape.txt",
        data: Buffer.from("x"),
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "target_directory_invalid"
    );
  });
});

test("overwrites text file content only inside the selected root", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const outsideFile = path.join(workspaceRoot, "outside.txt");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "note.md"), "before");
    await writeFile(outsideFile, "outside");
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 32,
    });

    const opened = await service.readTextFile({ rootDir: "project", path: "project/note.md" });
    const written = await service.writeTextFile({
      rootDir: "project",
      path: "project/note.md",
      content: "after edit",
      expectedVersion: opened.version,
    });
    assert.equal(written.path, "project/note.md");
    assert.equal(written.directory, "project");
    assert.equal(written.size, Buffer.byteLength("after edit"));
    assert.equal(await readFile(path.join(projectRoot, "note.md"), "utf8"), "after edit");

    const emptied = await service.writeTextFile({
      rootDir: "project",
      path: "project/note.md",
      content: "",
      expectedVersion: written.version,
    });
    assert.equal(emptied.size, 0);
    assert.equal(await readFile(path.join(projectRoot, "note.md"), "utf8"), "");

    await assert.rejects(
      service.writeTextFile({
        rootDir: "project",
        path: "project/note.md",
        content: "x".repeat(33),
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "file_too_large"
    );
    await assert.rejects(
      service.writeTextFile({
        rootDir: "project",
        path: "outside.txt",
        content: "hacked",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "path_invalid"
    );
    await assert.rejects(
      service.writeTextFile({
        rootDir: "project",
        path: "project/missing.txt",
        content: "new",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "path_invalid"
    );
    await assert.rejects(
      service.writeTextFile({
        rootDir: "project",
        path: "project/note.md",
        content: undefined,
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "content_required"
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
  });
});

test("rejects a text write when the file changed after it was opened", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const targetPath = path.join(projectRoot, "note.md");
    await mkdir(projectRoot);
    await writeFile(targetPath, "opened content");
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });

    const opened = await service.readTextFile({ rootDir: "project", path: "project/note.md" });
    await writeFile(targetPath, "external edit");

    await assert.rejects(
      service.writeTextFile({
        rootDir: "project",
        path: "project/note.md",
        content: "editor save",
        expectedVersion: opened.version,
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "file_changed"
    );
    assert.equal(await readFile(targetPath, "utf8"), "external edit");
  });
});

test("creates an empty text file and rejects duplicates or escapes", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const outsideDirectory = path.join(workspaceRoot, "outside");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideDirectory);
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });

    const created = await service.createTextFile({
      rootDir: "project",
      targetDirectory: "project",
      fileName: "memo.md",
    });
    assert.equal(created.path, "project/memo.md");
    assert.equal(created.size, 0);
    assert.equal(await readFile(path.join(projectRoot, "memo.md"), "utf8"), "");

    await assert.rejects(
      service.createTextFile({
        rootDir: "project",
        targetDirectory: "project",
        fileName: "memo.md",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "file_exists"
    );
    await assert.rejects(
      service.createTextFile({
        rootDir: "project",
        targetDirectory: "project",
        fileName: "../escape.md",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "invalid_file_name"
    );
    await assert.rejects(
      service.createTextFile({
        rootDir: "project",
        targetDirectory: "outside",
        fileName: "escape.md",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "target_directory_invalid"
    );
  });
});

test("rejects text writes through symbolic links", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const outsideFile = path.join(workspaceRoot, "outside.txt");
    await mkdir(projectRoot);
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, path.join(projectRoot, "linked.txt"));
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });

    await assert.rejects(
      service.writeTextFile({
        rootDir: "project",
        path: "project/linked.txt",
        content: "hacked",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "path_invalid"
    );
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
  });
});

test("renames and deletes files only inside the selected root", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const nestedDirectory = path.join(projectRoot, "nested");
    const outsideFile = path.join(workspaceRoot, "outside.txt");
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(path.join(nestedDirectory, "before.txt"), "hello");
    await writeFile(path.join(nestedDirectory, "existing.txt"), "keep");
    await writeFile(outsideFile, "outside");
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });

    const renamed = await service.renameFile({
      rootDir: "project",
      path: "project/nested/before.txt",
      name: "after.txt",
    });

    assert.equal(renamed.previousPath, "project/nested/before.txt");
    assert.equal(renamed.previousDirectory, "project/nested");
    assert.equal(renamed.path, "project/nested/after.txt");
    assert.equal(renamed.directory, "project/nested");
    assert.equal(await readFile(path.join(nestedDirectory, "after.txt"), "utf8"), "hello");
    await assert.rejects(access(path.join(nestedDirectory, "before.txt")));

    await assert.rejects(
      service.renameFile({
        rootDir: "project",
        path: "nested/after.txt",
        name: "existing.txt",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "file_exists"
    );
    await assert.rejects(
      service.deleteFile({
        rootDir: "project",
        path: "outside.txt",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "path_invalid"
    );
    await assert.rejects(
      service.deleteFile({
        rootDir: "project",
        path: "project/nested",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "not_a_file"
    );

    const deleted = await service.deleteFile({
      rootDir: "project",
      path: "nested/after.txt",
    });
    assert.equal(deleted.path, "project/nested/after.txt");
    assert.equal(deleted.directory, "project/nested");
    await assert.rejects(access(path.join(nestedDirectory, "after.txt")));
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
  });
});

test("rejects file mutations through symbolic links", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    const targetFile = path.join(projectRoot, "target.txt");
    await mkdir(projectRoot);
    await writeFile(targetFile, "target");
    await symlink(targetFile, path.join(projectRoot, "linked.txt"));
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });

    await assert.rejects(
      service.deleteFile({
        rootDir: "project",
        path: "project/linked.txt",
      }),
      (error) => error instanceof WorkspaceFilesError && error.code === "path_invalid"
    );
    assert.equal(await readFile(targetFile, "utf8"), "target");
  });
});

test("accepts an authenticated multipart upload request", async () => {
  await withTempDir(async (workspaceRoot) => {
    await mkdir(path.join(workspaceRoot, "project"));
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });
    const server = http.createServer((req, res) => service.handleRequest(req, res, {
      expectedToken: "test-token",
      receivedToken: String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""),
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const form = new FormData();
      form.set("rootDir", "project");
      form.set("targetDirectory", "project");
      form.set("fileName", "multipart.txt");
      form.set("file", new Blob(["multipart body"], { type: "text/plain" }), "multipart.txt");
      const response = await fetch(`http://127.0.0.1:${address.port}/workspace/files`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
        body: form,
      });
      const payload = await response.json();

      assert.equal(response.status, 201);
      assert.equal(payload.path, "project/multipart.txt");
      assert.equal(
        await readFile(path.join(workspaceRoot, "project", "multipart.txt"), "utf8"),
        "multipart body"
      );
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });
});

test("accepts authenticated write, rename, and delete requests", async () => {
  await withTempDir(async (workspaceRoot) => {
    const projectRoot = path.join(workspaceRoot, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "before.txt"), "body");
    const service = createWorkspaceFilesService({
      workspaceRoot,
      maxUploadBytes: 1024,
    });
    const server = http.createServer((req, res) => service.handleRequest(req, res, {
      expectedToken: "test-token",
      receivedToken: String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""),
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}/workspace/files`;
      const createResponse = await fetch(baseUrl, {
        method: "PUT",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          create: true,
          rootDir: "project",
          targetDirectory: "project",
          name: "created.md",
        }),
      });
      const createPayload = await createResponse.json();
      assert.equal(createResponse.status, 200);
      assert.equal(createPayload.path, "project/created.md");
      assert.equal(await readFile(path.join(projectRoot, "created.md"), "utf8"), "");

      const readResponse = await fetch(`${baseUrl}?rootDir=project&path=project%2Fbefore.txt`, {
        headers: { authorization: "Bearer test-token" },
      });
      const readPayload = await readResponse.json();
      assert.equal(readResponse.status, 200);
      assert.equal(readPayload.content, "body");
      assert.match(readPayload.version, /^[a-f0-9]{64}$/);

      const writeResponse = await fetch(baseUrl, {
        method: "PUT",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rootDir: "project",
          path: "project/before.txt",
          content: "edited body",
          expectedVersion: readPayload.version,
        }),
      });
      const writePayload = await writeResponse.json();
      assert.equal(writeResponse.status, 200);
      assert.equal(writePayload.path, "project/before.txt");
      assert.equal(writePayload.size, Buffer.byteLength("edited body"));
      assert.equal(
        await readFile(path.join(projectRoot, "before.txt"), "utf8"),
        "edited body"
      );

      const renameResponse = await fetch(baseUrl, {
        method: "PATCH",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rootDir: "project",
          path: "project/before.txt",
          name: "after.txt",
        }),
      });
      const renamePayload = await renameResponse.json();
      assert.equal(renameResponse.status, 200);
      assert.equal(renamePayload.path, "project/after.txt");
      assert.equal(renamePayload.directory, "project");
      assert.equal(renamePayload.previousDirectory, "project");

      const deleteResponse = await fetch(baseUrl, {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rootDir: "project",
          path: "project/after.txt",
        }),
      });
      const deletePayload = await deleteResponse.json();
      assert.equal(deleteResponse.status, 200);
      assert.equal(deletePayload.path, "project/after.txt");
      assert.equal(deletePayload.directory, "project");
      await assert.rejects(access(path.join(projectRoot, "after.txt")));
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });
});
