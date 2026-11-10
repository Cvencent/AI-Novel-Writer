using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace AiNovelSecureFs {
  /**
   * 原生宿主的协议层：与 windows-safe-file-system.ps1 的请求/响应逐字一致。
   *
   * 为什么要有这个宿主（issue #245）：PowerShell 助手每次要付 ~183ms 进程启动 +
   * ~210ms Add-Type 现场编译（干活只 1-4ms），常驻又要 84MB 内存所以只能空闲退出。
   * 同一个 C# 安全实现编成 exe 后：启动 ~25ms、每请求 ~0.04ms、常驻仅 13MB。
   *
   * ⚠️ 安全判据一行都没有改动：这里只是把 PS1 里那段 $nativeSource 的调用方照搬过来，
   * 所有路径校验、OBJ_DONT_REPARSE 打开、原子替换仍由 SecureHandleFileSystem 完成。
   * 两个后端必须对同一请求给出同一响应——由 electron/security/__tests__ 的一致性用例守着。
   */
  public static class HelperHost {
    private const int MaxRequestCharacters = 100000000;
    private const int MaxCommandCharacters = 4096;
    private const int MaxReadBytes = 67108864;

    public static int Main(string[] args) {
      var serve = Array.IndexOf(args, "--serve") >= 0;
      if (serve) {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          if (line.Length == 0) continue;
          WriteResponse(InvokeRequest(line));
          Console.Out.Flush();
        }
        return 0;
      }
      WriteResponse(InvokeRequest(Console.In.ReadLine()));
      Console.Out.Flush();
      return 0;
    }

    /** 单个请求：成功或失败都产出一份响应对象，绝不把异常抛出（serve 模式要活下去）。 */
    public static Dictionary<string, object> InvokeRequest(string inputLine) {
      try {
        if (inputLine == null || inputLine.Length > MaxRequestCharacters) {
          throw new SecureFsException("SECURE_FS_REQUEST_TOO_LARGE");
        }
        var request = Json.ParseObject(inputLine);
        Require(request, "operation");
        Require(request, "rootPath");
        Require(request, "relativePath");
        Require(request, "rootIdentity");
        var rootPath = Json.AsString(request["rootPath"]);
        var relativePath = Json.AsString(request["relativePath"]);
        if (rootPath == null || relativePath == null) throw new SecureFsException("SECURE_FS_INVALID_PATH");
        var identityValue = request["rootIdentity"] as Dictionary<string, object>;
        if (identityValue == null) throw new SecureFsException("SECURE_FS_INVALID_PATH");
        Require(identityValue, "volumeSerialNumber");
        Require(identityValue, "fileIndex");
        var volumeSerialNumber = Json.AsString(identityValue["volumeSerialNumber"]);
        var fileIndex = Json.AsString(identityValue["fileIndex"]);
        if (volumeSerialNumber == null || fileIndex == null) throw new SecureFsException("SECURE_FS_INVALID_PATH");
        var rootIdentity = SecureHandleFileSystem.ParseRootIdentity(volumeSerialNumber, fileIndex);

        var operation = Json.AsString(request["operation"]) ?? "";
        switch (operation) {
          case "read": {
            if (!request.ContainsKey("maxBytes")) throw new SecureFsException("SECURE_FS_INVALID_OPERATION");
            var maxBytes = Json.AsInt(request["maxBytes"]);
            if (maxBytes == null || maxBytes < 0 || maxBytes > MaxReadBytes) {
              throw new SecureFsException("SECURE_FS_INVALID_OPERATION");
            }
            var contentBase64 = SecureHandleFileSystem.ReadTextBase64(rootPath, rootIdentity, relativePath, maxBytes.Value);
            return Ok("contentBase64", contentBase64);
          }
          case "write": {
            // 与 PS1 一致：缺键或类型不对都归 INVALID_TEXT（不是 INVALID_PATH）。
            if (!request.ContainsKey("contentBase64")) throw new SecureFsException("SECURE_FS_INVALID_TEXT");
            var encoded = Json.AsString(request["contentBase64"]);
            if (encoded == null) throw new SecureFsException("SECURE_FS_INVALID_TEXT");
            var mustAlreadyExist = false;
            if (request.ContainsKey("mustAlreadyExist")) {
              var flag = request["mustAlreadyExist"];
              if (!(flag is bool)) throw new SecureFsException("SECURE_FS_INVALID_OPERATION");
              mustAlreadyExist = (bool)flag;
            }
            byte[] content;
            try { content = Convert.FromBase64String(encoded); }
            catch (FormatException) { throw new SecureFsException("SECURE_FS_INVALID_TEXT"); }
            SecureHandleFileSystem.AtomicWriteSession session = null;
            try {
              session = SecureHandleFileSystem.BeginAtomicWrite(rootPath, rootIdentity, relativePath, content, mustAlreadyExist);
              WriteResponse(Ok("phase", "ready"));
              var commandLine = Console.In.ReadLine();
              if (commandLine == null || commandLine.Length > MaxCommandCharacters) {
                throw new SecureFsException("SECURE_FS_CANCELLED");
              }
              var command = Json.ParseObject(commandLine);
              var name = command.ContainsKey("command") ? Json.AsString(command["command"]) : null;
              if (name != "commit") {
                // 与 PS1 一致：取消是「响应失败」而不是抛错（不写盘、也不升级成通道故障）。
                return Failed("SECURE_FS_CANCELLED");
              }
              session.Commit(mustAlreadyExist);
              return Ok(null, null);
            } finally {
              if (session != null) session.Dispose();
            }
          }
          case "mkdir": {
            SecureHandleFileSystem.MakeDirectory(rootPath, rootIdentity, relativePath);
            return Ok(null, null);
          }
          case "exists": {
            var exists = SecureHandleFileSystem.Exists(rootPath, rootIdentity, relativePath);
            var response = Ok(null, null);
            response["exists"] = exists;
            return response;
          }
          case "list": {
            var entries = SecureHandleFileSystem.ListDirectory(rootPath, rootIdentity, relativePath);
            var list = new List<object>(entries.Length);
            foreach (var entry in entries) {
              list.Add(new Dictionary<string, object> { { "name", entry.Name }, { "isDirectory", entry.IsDirectory } });
            }
            var response = Ok(null, null);
            response["entries"] = list;
            return response;
          }
          default:
            throw new SecureFsException("SECURE_FS_INVALID_OPERATION");
        }
      } catch (Exception error) {
        return Failed(ErrorCode(error));
      }
    }

    private static void Require(Dictionary<string, object> value, string key) {
      if (!value.ContainsKey(key)) throw new SecureFsException("SECURE_FS_INVALID_PATH");
    }

    /** 与 PS1 的 catch 块同一套码值判定：内层 SecureFsException 优先，其次裸码消息。 */
    private static string ErrorCode(Exception error) {
      for (var current = error; current != null; current = current.InnerException) {
        var secure = current as SecureFsException;
        if (secure != null) return secure.Code;
        if (current.Message != null && IsCode(current.Message)) return current.Message;
      }
      return "SECURE_FS_HELPER_FAILED";
    }

    private static bool IsCode(string value) {
      if (value.Length < 8 || !value.StartsWith("SECURE_FS_", StringComparison.Ordinal)) return false;
      for (var index = "SECURE_FS_".Length; index < value.Length; index++) {
        var character = value[index];
        if (!(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && character != '_') return false;
      }
      return true;
    }

    private static Dictionary<string, object> Ok(string key, object value) {
      var response = new Dictionary<string, object> { { "ok", true } };
      if (key != null) response[key] = value;
      return response;
    }

    private static Dictionary<string, object> Failed(string code) {
      return new Dictionary<string, object> { { "ok", false }, { "code", code } };
    }

    private static void WriteResponse(Dictionary<string, object> response) {
      Console.Out.WriteLine(Json.Write(response));
    }
  }

  /**
   * 极小的 JSON 读写。
   *
   * 为什么不用 System.Text.Json：目标是 .NET Framework 的 csc（构建机上只有它，
   * 没有 dotnet SDK），4.x 不带 System.Text.Json。这里只处理本协议自己的形状
   * （对象/字符串/数字/布尔/数组），解析失败一律按坏请求处理，绝不放宽校验。
   */
  internal static class Json {
    public static Dictionary<string, object> ParseObject(string text) {
      var index = 0;
      var value = ParseValue(text, ref index);
      SkipWhitespace(text, ref index);
      if (index != text.Length) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
      var result = value as Dictionary<string, object>;
      if (result == null) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      return result;
    }

    public static string AsString(object value) {
      return value as string;
    }

    public static int? AsInt(object value) {
      if (value is long) {
        var number = (long)value;
        if (number < int.MinValue || number > int.MaxValue) return null;
        return (int)number;
      }
      return null;
    }

    public static string Write(object value) {
      var builder = new StringBuilder();
      WriteValue(builder, value);
      return builder.ToString();
    }

    private static void WriteValue(StringBuilder builder, object value) {
      if (value == null) { builder.Append("null"); return; }
      if (value is string) { WriteString(builder, (string)value); return; }
      if (value is bool) { builder.Append((bool)value ? "true" : "false"); return; }
      if (value is Dictionary<string, object>) {
        builder.Append('{');
        var first = true;
        foreach (var pair in (Dictionary<string, object>)value) {
          if (!first) builder.Append(',');
          first = false;
          WriteString(builder, pair.Key);
          builder.Append(':');
          WriteValue(builder, pair.Value);
        }
        builder.Append('}');
        return;
      }
      if (value is IEnumerable<object>) {
        builder.Append('[');
        var first = true;
        foreach (var item in (IEnumerable<object>)value) {
          if (!first) builder.Append(',');
          first = false;
          WriteValue(builder, item);
        }
        builder.Append(']');
        return;
      }
      if (value is long) { builder.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
      if (value is int) { builder.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
      throw new SecureFsException("SECURE_FS_HELPER_FAILED");
    }

    private static void WriteString(StringBuilder builder, string value) {
      builder.Append('"');
      foreach (var character in value) {
        switch (character) {
          case '"': builder.Append("\\\""); break;
          case '\\': builder.Append("\\\\"); break;
          case '\b': builder.Append("\\b"); break;
          case '\f': builder.Append("\\f"); break;
          case '\n': builder.Append("\\n"); break;
          case '\r': builder.Append("\\r"); break;
          case '\t': builder.Append("\\t"); break;
          default:
            if (character < ' ') builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
            else builder.Append(character);
            break;
        }
      }
      builder.Append('"');
    }

    private static object ParseValue(string text, ref int index) {
      SkipWhitespace(text, ref index);
      if (index >= text.Length) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
      var character = text[index];
      if (character == '{') return ParseObjectBody(text, ref index);
      if (character == '[') return ParseArray(text, ref index);
      if (character == '"') return ParseString(text, ref index);
      if (Matches(text, index, "true")) { index += 4; return true; }
      if (Matches(text, index, "false")) { index += 5; return false; }
      if (Matches(text, index, "null")) { index += 4; return null; }
      return ParseNumber(text, ref index);
    }

    private static Dictionary<string, object> ParseObjectBody(string text, ref int index) {
      var result = new Dictionary<string, object>(StringComparer.Ordinal);
      index++;
      SkipWhitespace(text, ref index);
      if (index < text.Length && text[index] == '}') { index++; return result; }
      while (true) {
        SkipWhitespace(text, ref index);
        if (index >= text.Length || text[index] != '"') throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        var key = ParseString(text, ref index);
        SkipWhitespace(text, ref index);
        if (index >= text.Length || text[index] != ':') throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        index++;
        result[key] = ParseValue(text, ref index);
        SkipWhitespace(text, ref index);
        if (index >= text.Length) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        if (text[index] == ',') { index++; continue; }
        if (text[index] == '}') { index++; return result; }
        throw new SecureFsException("SECURE_FS_HELPER_FAILED");
      }
    }

    private static List<object> ParseArray(string text, ref int index) {
      var result = new List<object>();
      index++;
      SkipWhitespace(text, ref index);
      if (index < text.Length && text[index] == ']') { index++; return result; }
      while (true) {
        result.Add(ParseValue(text, ref index));
        SkipWhitespace(text, ref index);
        if (index >= text.Length) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        if (text[index] == ',') { index++; continue; }
        if (text[index] == ']') { index++; return result; }
        throw new SecureFsException("SECURE_FS_HELPER_FAILED");
      }
    }

    private static string ParseString(string text, ref int index) {
      var builder = new StringBuilder();
      index++;
      while (true) {
        if (index >= text.Length) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        var character = text[index++];
        if (character == '"') return builder.ToString();
        if (character != '\\') { builder.Append(character); continue; }
        if (index >= text.Length) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        var escape = text[index++];
        switch (escape) {
          case '"': builder.Append('"'); break;
          case '\\': builder.Append('\\'); break;
          case '/': builder.Append('/'); break;
          case 'b': builder.Append('\b'); break;
          case 'f': builder.Append('\f'); break;
          case 'n': builder.Append('\n'); break;
          case 'r': builder.Append('\r'); break;
          case 't': builder.Append('\t'); break;
          case 'u': {
            if (index + 4 > text.Length) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
            var code = int.Parse(text.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            builder.Append((char)code);
            index += 4;
            break;
          }
          default: throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        }
      }
    }

    private static object ParseNumber(string text, ref int index) {
      var start = index;
      if (index < text.Length && (text[index] == '-' || text[index] == '+')) index++;
      while (index < text.Length && text[index] >= '0' && text[index] <= '9') index++;
      if (index == start) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
      var integer = long.Parse(text.Substring(start, index - start), NumberStyles.Integer, CultureInfo.InvariantCulture);
      // 本协议只用整数；小数/指数一律当坏请求，不做静默截断。
      if (index < text.Length && (text[index] == '.' || text[index] == 'e' || text[index] == 'E')) {
        throw new SecureFsException("SECURE_FS_HELPER_FAILED");
      }
      return integer;
    }

    /** .NET Framework 4.0 没有 string.StartsWith(string, int, StringComparison) 重载。 */
    private static bool Matches(string text, int index, string token) {
      return index + token.Length <= text.Length
        && string.CompareOrdinal(text, index, token, 0, token.Length) == 0;
    }

    private static void SkipWhitespace(string text, ref int index) {
      while (index < text.Length && (text[index] == ' ' || text[index] == '\t' || text[index] == '\n' || text[index] == '\r')) index++;
    }
  }
}
