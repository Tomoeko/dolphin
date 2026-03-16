// Copyright 2024 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "DolphinTool/FifoCommand.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <OptionParser.h>
#include <fmt/ostream.h>
#include <fmt/format.h>

#include "Common/CommonTypes.h"
#include "Common/Config/Config.h"
#include "Common/FileUtil.h"
#include "Common/Swap.h"
#include "Core/Boot/Boot.h"
#include "Core/BootManager.h"
#include "Core/Config/MainSettings.h"
#include "Core/Core.h"
#include <condition_variable>
#include <mutex>
#include "VideoCommon/BPMemory.h"
#include "VideoCommon/XFMemory.h"
#include "Core/FifoPlayer/FifoPlayer.h"
#include "Core/System.h"
#include "UICommon/UICommon.h"
#include "VideoCommon/CPMemory.h"
#include "VideoCommon/FrameDumper.h"
#include "VideoCommon/OpcodeDecoding.h"
#include "VideoCommon/VideoBackendBase.h"
#include "VideoCommon/VideoConfig.h"
#include "Core/Config/GraphicsSettings.h"

namespace DolphinTool
{

class JsonCallback : public OpcodeDecoder::Callback
{
public:
  explicit JsonCallback(CPState& cpmem, std::ofstream& out) : m_cpmem(cpmem), m_out(out) {}

  OPCODE_CALLBACK(void OnCP(const u8 command, const u32 value))
  {
    m_cpmem.LoadCPReg(command, value);
    fmt::print(m_out, "      {{\"type\": \"CP\", \"command\": {}, \"value\": {}}},\n", command, value);
  }

  OPCODE_CALLBACK(void OnXF(const u16 address, const u8 count, const u8* data))
  {
    fmt::print(m_out, "      {{\"type\": \"XF\", \"address\": {}, \"count\": {}, \"data\": [", address, count);
    for (u8 i = 0; i < count; i++) {
        const u32 value = Common::swap32(&data[i * 4]);
        fmt::print(m_out, "{}{}", value, (i == count - 1) ? "" : ", ");
    }
    fmt::print(m_out, "]}},\n");
  }

  OPCODE_CALLBACK(void OnBP(const u8 command, const u32 value))
  {
    m_bp_regs[command] = value;
    fmt::print(m_out, "      {{\"type\": \"BP\", \"command\": {}, \"value\": {}}},\n", command, value);
  }

  OPCODE_CALLBACK(void OnIndexedLoad(const CPArray array, const u32 index, const u16 address, const u8 size))
  {
    fmt::print(m_out, "      {{\"type\": \"IndexedLoad\", \"array\": {}, \"index\": {}, \"address\": {}, \"size\": {}}},\n",
               static_cast<u32>(array), index, address, size);
  }

  OPCODE_CALLBACK(void OnPrimitiveCommand(const OpcodeDecoder::Primitive primitive, const u8 vat, const u32 vertex_size, const u16 num_vertices, const u8* vertex_data))
  {
    fmt::print(m_out, "      {{\"type\": \"Primitive\", \"primitive\": {}, \"vat\": {}, \"vertex_size\": {}, \"num_vertices\": {}, \"data\": [",
               static_cast<u32>(primitive), vat, vertex_size, num_vertices);
    const u32 total_size = vertex_size * num_vertices;
    for (u32 i = 0; i < total_size; i++) {
        fmt::print(m_out, "{}{}", vertex_data[i], (i == total_size - 1) ? "" : ", ");
    }
    fmt::print(m_out, "], \"vcd_lo\": {}, \"vcd_hi\": {}, \"vat_a\": {}, \"vat_b\": {}, \"vat_c\": {}, ",
               m_cpmem.vtx_desc.low.Hex, m_cpmem.vtx_desc.high.Hex,
               m_cpmem.vtx_attr[vat].g0.Hex, m_cpmem.vtx_attr[vat].g1.Hex, m_cpmem.vtx_attr[vat].g2.Hex);

    // Export resolved XF State (Projection and Viewport)
    fmt::print(m_out, "\n      \"xf_viewport\": [{}, {}, {}, {}, {}, {}], ",
               xfmem.viewport.wd, xfmem.viewport.ht, xfmem.viewport.zRange,
               xfmem.viewport.xOrig, xfmem.viewport.yOrig, xfmem.viewport.farZ);
    fmt::print(m_out, "\"xf_projection\": [{}, {}, {}, {}, {}, {}, {}], ",
               xfmem.projection.rawProjection[0], xfmem.projection.rawProjection[1],
               xfmem.projection.rawProjection[2], xfmem.projection.rawProjection[3],
               xfmem.projection.rawProjection[4], xfmem.projection.rawProjection[5],
               static_cast<u32>(xfmem.projection.type));

    fmt::print(m_out, "\"tev_stages\": [");
    // Export up to 16 TEV stages
    for (u8 s = 0; s < 16; s++) {
        fmt::print(m_out, "{{\"color\": {}, \"alpha\": {}}}{}", 
            m_bp_regs[0xC0 + s*2], m_bp_regs[0xC1 + s*2], (s == 15) ? "" : ", ");
    }
    fmt::print(m_out, "], \"tev_kcolors\": [");
    for (u8 k = 0; k < 4; k++) { // 4 KColors (each takes 2 regs in some mappings, but let's use 0xE0-0xE7)
        fmt::print(m_out, "{{\"ra\": {}, \"gb\": {}}}{}", 
            m_bp_regs[0xE0 + k*2], m_bp_regs[0xE1 + k*2], (k == 3) ? "" : ", ");
    }
    fmt::print(m_out, "], \"zmode\": {}, \"alpha_test\": {}, \"blend_mode\": {}", 
               m_bp_regs[0x40], m_bp_regs[0xF3], m_bp_regs[0x41]);
    fmt::print(m_out, "}},\n");
  }

  OPCODE_CALLBACK(void OnDisplayList(const u32 address, const u32 size))
  {
    fmt::print(m_out, "      {{\"type\": \"DisplayList\", \"address\": {}, \"size\": {}}},\n", address, size);
  }

  OPCODE_CALLBACK(void OnNop(const u32 count))
  {
    fmt::print(m_out, "      {{\"type\": \"NOP\", \"count\": {}}},\n", count);
  }

  OPCODE_CALLBACK(void OnUnknown(u8 opcode, const u8* data))
  {
    fmt::print(m_out, "      {{\"type\": \"Unknown\", \"opcode\": {}}},\n", opcode);
  }

  OPCODE_CALLBACK(void OnCommand(const u8* data, u32 size)) {}

  OPCODE_CALLBACK(CPState& GetCPState()) { return m_cpmem; }

  CPState& m_cpmem;
  std::ofstream& m_out;
  std::map<u8, u32> m_bp_regs;
};

#pragma pack(push, 1)
struct FileHeader
{
  u32 fileId;
  u32 file_version;
  u32 min_loader_version;
  u64 bpMemOffset;
  u32 bpMemSize;
  u64 cpMemOffset;
  u32 cpMemSize;
  u64 xfMemOffset;
  u32 xfMemSize;
  u64 xfRegsOffset;
  u32 xfRegsSize;
  u64 frameListOffset;
  u32 frameCount;
  u32 flags;
  u64 texMemOffset;
  u32 texMemSize;
  u32 mem1_size;
  u32 mem2_size;
  char gameid[8];
  u8 reserved[24];
};

struct FileFrameInfo
{
  u64 fifoDataOffset;
  u32 fifoDataSize;
  u32 fifoStart;
  u32 fifoEnd;
  u64 memoryUpdatesOffset;
  u32 numMemoryUpdates;
  u8 reserved[32];
};

struct FileMemoryUpdate
{
  u32 fifoPosition;
  u32 address;
  u64 dataOffset;
  u32 dataSize;
  u8 type;
  u8 reserved[3];
};
#pragma pack(pop)

static int ScreenshotCommand(const std::vector<std::string>& args)
{
  optparse::OptionParser parser;
  parser.add_option("-i", "--in")
      .type("string")
      .action("store")
      .help("Path to input .dff FILE.")
      .metavar("FILE");
  parser.add_option("-o", "--out")
      .type("string")
      .action("store")
      .help("Path to output PNG FILE.")
      .metavar("FILE");
  parser.add_option("-d", "--draw-call")
      .type("int")
      .action("store")
      .help("Stop rendering at specific draw call index.")
      .metavar("INDEX")
      .set_default(0);
  parser.add_option("-b", "--backend")
      .type("string")
      .action("store")
      .help("Video backend to use (Software, OpenGL, Vulkan). Default: Software")
      .metavar("BACKEND")
      .set_default("Software");
  parser.add_option("--bulk-dir")
      .type("string")
      .action("store")
      .help("Output directory for bulk screenshots.");
  parser.add_option("--deduplicate").action("store_true").help("Deduplicate screenshots by image hash and create manifest.json.");
  parser.add_option("--resolution-type")
      .type("string")
      .action("store")
      .help("Resolution type: window, aspect, or raw")
      .set_default("aspect");

  const optparse::Values& options = parser.parse_args(args);

  if (!options.is_set("in") || (!options.is_set("out") && !options.is_set("bulk_dir")))
  {
    fmt::print(std::cerr, "Error: Missing input or output/bulk_dir\n");
    return EXIT_FAILURE;
  }

  const std::string input_path = options["in"];
  const std::string output_path = options.is_set("out") ? options["out"] : "";
  const std::string backend = options["backend"];
  const std::string bulk_dir = options.is_set("bulk_dir") ? options["bulk_dir"] : "";
  const bool is_bulk = !bulk_dir.empty();

  UICommon::SetUserDirectory("");
  
  // Force single core and requested backend for reliability in headless tool
  Config::Init();
  Config::SetCurrent(Config::MAIN_CPU_THREAD, false);
  Config::SetCurrent(Config::MAIN_GFX_BACKEND, backend);
  Config::SetCurrent(Config::MAIN_FIFOPLAYER_LOOP_REPLAY, false);
  
  const std::string res_type_str = options["resolution_type"];
  FrameDumpResolutionType res_type = FrameDumpResolutionType::XFBAspectRatioCorrectedResolution;
  if (res_type_str == "window")
    res_type = FrameDumpResolutionType::WindowResolution;
  else if (res_type_str == "aspect")
    res_type = FrameDumpResolutionType::XFBAspectRatioCorrectedResolution;
  else if (res_type_str == "raw")
    res_type = FrameDumpResolutionType::XFBRawResolution;
  else
    fmt::print(std::cerr, "Warning: Unknown resolution type '{}', defaulting to 'aspect'\n", res_type_str);

  UICommon::Init();
  Config::SetCurrent(Config::GFX_FRAME_DUMPS_RESOLUTION_TYPE, res_type);

  auto& system = Core::System::GetInstance();
  
  WindowSystemInfo wsi;
  VideoBackendBase::PopulateBackendInfo(wsi);
  UICommon::InitControllers(wsi);

  auto boot = BootParameters::GenerateFromFile(input_path);
  if (!boot)
  {
    fmt::print(std::cerr, "Error: Failed to load DFF file {}\n", input_path);
    return EXIT_FAILURE;
  }

  const int stop_draw_call = options.is_set("draw-call") ? std::stoi(options["draw-call"]) : -1;
  
  std::mutex sync_mutex;
  std::condition_variable sync_cv;
  std::atomic<bool> frame_done = false;

  if (is_bulk) {
    // Bulk mode: Loop through all draw calls in one process.
    if (!BootManager::BootCore(system, std::move(boot), wsi))
    {
      fmt::print(std::cerr, "Error: Failed to boot DFF file\n");
      return EXIT_FAILURE;
    }

    // Wait for the FIFO to be loaded so we can count draw calls
    u32 total_draws = 0;
    int wait_timer = 5000; // 5 seconds timeout
    while (total_draws == 0 && wait_timer > 0) {
        total_draws = system.GetFifoPlayer().GetFrameObjectCount(0);
        if (total_draws == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            wait_timer -= 100;
        }
    }

    if (total_draws == 0) {
        fmt::print(std::cerr, "Error: Could not determine draw call count or FIFO failed to load.\n");
        Core::Stop(system);
        Core::Shutdown(system);
        return EXIT_FAILURE;
    }

    File::CreateDirs(bulk_dir);
    fmt::print(std::cout, "Starting single-process bulk capture of {} draw calls to {}...\n", total_draws, bulk_dir);

    // Warmup: Wait for g_frame_dumper and render one frame to initialize backend
    system.GetFifoPlayer().SetFrameRangeEnd(1);
    int warmup_timeout = 100;
    while (!g_frame_dumper && warmup_timeout > 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        warmup_timeout--;
    }
    // Give backend more time to fully settle
    std::this_thread::sleep_for(std::chrono::seconds(2));

    // Initial sync
    system.GetFifoPlayer().SetFrameRangeEnd(0);
    
    system.GetFifoPlayer().SetFrameWrittenCallback([&] {
      {
        std::lock_guard<std::mutex> lk(sync_mutex);
        frame_done = true;
      }
      sync_cv.notify_one();
    });

    std::unordered_map<u64, std::string> seen_hashes;
    std::vector<std::pair<u32, u64>> manifest;

    for (u32 i = 0; i < total_draws; ++i) {
        {
           std::unique_lock<std::mutex> lk(sync_mutex);
           frame_done = false;
        }
        
        system.GetFifoPlayer().SetObjectRangeEnd(i + 1);
        
        // Wait for frame rendering
        {
          std::unique_lock<std::mutex> lk(sync_mutex);
          if (!sync_cv.wait_for(lk, std::chrono::seconds(10), [&] { return frame_done.load(); })) {
              fmt::print(std::cerr, "Timeout waiting for draw call {}\n", i);
              break;
          }
        }

        if (g_frame_dumper) {
            // Small sleep to ensure renderer has caught up and readback is fresh
            std::this_thread::sleep_for(std::chrono::milliseconds(20));

            // Ensure any previous work is flushed
            g_frame_dumper->FlushFrameDump();

            // Force a screenshot request to trigger readback and hashing
            g_frame_dumper->SaveScreenshot("tmp_hash.png");
            g_frame_dumper->WaitForScreenshot();
            
            u64 hash = g_frame_dumper->GetLastFrameHash();
            manifest.push_back({i, hash});

            if (options.is_set("deduplicate")) {
                if (seen_hashes.find(hash) == seen_hashes.end()) {
                    u32 unique_idx = static_cast<u32>(seen_hashes.size());
                    std::string filename = fmt::format("dc_{}.png", unique_idx);
                    std::string path = fmt::format("{}/{}", bulk_dir, filename);
                    g_frame_dumper->SaveScreenshot(path);
                    g_frame_dumper->WaitForScreenshot();
                    seen_hashes[hash] = filename;
                }
            } else {
                std::string path = fmt::format("{}/dc_{}.png", bulk_dir, i);
                g_frame_dumper->SaveScreenshot(path);
                g_frame_dumper->WaitForScreenshot();
            }
        }

        if ((i + 1) % 10 == 0 || i + 1 == total_draws) {
            fmt::print(std::cout, "\rDumped {}/{}...", i+1, total_draws);
            std::cout.flush();
        }
    }
    
    if (options.is_set("deduplicate")) {
        std::ofstream manifest_file(fmt::format("{}/manifest.json", bulk_dir));
        manifest_file << "{\n  \"draw_calls\": [\n";
        for (size_t i = 0; i < manifest.size(); ++i) {
            manifest_file << fmt::format("    {{\"index\": {}, \"hash\": \"{:016x}\", \"filename\": \"{}\"}}", 
                manifest[i].first, manifest[i].second, seen_hashes[manifest[i].second]);
            if (i < manifest.size() - 1) manifest_file << ",";
            manifest_file << "\n";
        }
        manifest_file << "  ]\n}\n";
    }
    
    fmt::print(std::cout, "\nBulk capture complete.\n");
    File::Delete("tmp_hash.png");
    Core::Stop(system);
    Core::Shutdown(system);

    system.GetFifoPlayer().SetFrameWrittenCallback(nullptr);
    system.GetFifoPlayer().SetObjectFinishedCallback(nullptr);

  } else {
    // Single screenshot mode
    if (stop_draw_call >= 0) {
        system.GetFifoPlayer().SetObjectRangeEnd(static_cast<u32>(stop_draw_call));
    }

    std::atomic<bool> callback_triggered = false;
    system.GetFifoPlayer().SetFrameWrittenCallback([&] {
      if (callback_triggered.exchange(true))
        return;

      if (g_frame_dumper)
      {
        g_frame_dumper->SaveScreenshot(output_path);
      }
    });

    if (!BootManager::BootCore(system, std::move(boot), wsi))
    {
      fmt::print(std::cerr, "Error: Failed to boot DFF file\n");
      return EXIT_FAILURE;
    }

    int timeout_ms = 30000;
    while (!callback_triggered && timeout_ms > 0)
    {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      timeout_ms -= 100;
    }

    if (callback_triggered)
    {
      std::this_thread::sleep_for(std::chrono::seconds(2));
    }
    else
    {
      fmt::print(std::cerr, "Error: Screenshot callback timed out.\n");
    }
    fmt::print(std::cout, "Screenshot saved to {}\n", output_path);
  }

  // Common cleanup
  Core::Stop(system);
  Core::Shutdown(system);

  system.GetFifoPlayer().SetFrameWrittenCallback(nullptr);
  system.GetFifoPlayer().SetObjectFinishedCallback(nullptr);
  UICommon::ShutdownControllers();
  UICommon::Shutdown();

  return EXIT_SUCCESS;
}

int FifoCommand(const std::vector<std::string>& args)
{
  if (!args.empty() && args[0] == "screenshot")
  {
    std::vector<std::string> screenshot_args(args.begin() + 1, args.end());
    return ScreenshotCommand(screenshot_args);
  }

  optparse::OptionParser parser;
  parser.usage("usage: fifo [options]...");

  parser.add_option("-i", "--in")
      .type("string")
      .action("store")
      .help("Path to input .dff FILE.")
      .metavar("FILE");

  parser.add_option("-o", "--out")
      .type("string")
      .action("store")
      .help("Path to output JSON FILE.")
      .metavar("FILE");

  const optparse::Values& options = parser.parse_args(args);

  if (!options.is_set("in") || !options.is_set("out"))
  {
    fmt::print(std::cerr, "Error: Missing input or output\n");
    return EXIT_FAILURE;
  }
  
  std::ifstream infile(options["in"], std::ios::binary);
  if (!infile.is_open())
  {
    fmt::print(std::cerr, "Error: Could not open DFF file.\n");
    return EXIT_FAILURE;
  }

  FileHeader header;
  infile.read(reinterpret_cast<char*>(&header), sizeof(header));
  if (header.fileId != 0x0d01f1f0)
  {
    fmt::print(std::cerr, "Error: Invalid DFF magic.\n");
    return EXIT_FAILURE;
  }

  std::ofstream out(options["out"]);
  if (!out.is_open())
  {
    fmt::print(std::cerr, "Error: Could not open output file.\n");
    return EXIT_FAILURE;
  }

  std::string mem_out_path = options["out"];
  if (mem_out_path.size() >= 5 && mem_out_path.substr(mem_out_path.size() - 5) == ".json") {
      mem_out_path = mem_out_path.substr(0, mem_out_path.size() - 5) + ".mem";
  } else {
      mem_out_path += ".mem";
  }

  std::ofstream out_mem(mem_out_path, std::ios::binary);
  if (!out_mem.is_open())
  {
    fmt::print(std::cerr, "Error: Could not open output mem file.\n");
    return EXIT_FAILURE;
  }

  u32 cpSize = std::min<u32>(256, header.cpMemSize);
  std::vector<u32> cpData(cpSize);
  infile.seekg(header.cpMemOffset, std::ios::beg);
  infile.read(reinterpret_cast<char*>(cpData.data()), cpSize * sizeof(u32));
  CPState cpmem(cpData.data());

  fmt::print(out, "[\n");
  for (u32 i = 0; i < header.frameCount; ++i)
  {
    infile.seekg(header.frameListOffset + (i * sizeof(FileFrameInfo)), std::ios::beg);
    FileFrameInfo frameInfo;
    infile.read(reinterpret_cast<char*>(&frameInfo), sizeof(frameInfo));

    std::vector<u8> fifoData(frameInfo.fifoDataSize);
    infile.seekg(frameInfo.fifoDataOffset, std::ios::beg);
    infile.read(reinterpret_cast<char*>(fifoData.data()), frameInfo.fifoDataSize);

    fmt::print(out, "  {{\n    \"frame\": {},\n", i);
    fmt::print(out, "    \"memory_updates\": [\n");

    std::vector<FileMemoryUpdate> memUpdates(frameInfo.numMemoryUpdates);
    infile.seekg(frameInfo.memoryUpdatesOffset, std::ios::beg);
    infile.read(reinterpret_cast<char*>(memUpdates.data()), frameInfo.numMemoryUpdates * sizeof(FileMemoryUpdate));

    for (u32 j = 0; j < frameInfo.numMemoryUpdates; ++j) {
        const auto& update = memUpdates[j];
        
        std::vector<u8> updateData(update.dataSize);
        infile.seekg(update.dataOffset, std::ios::beg);
        infile.read(reinterpret_cast<char*>(updateData.data()), update.dataSize);

        u64 mem_offset = out_mem.tellp();
        out_mem.write(reinterpret_cast<const char*>(updateData.data()), update.dataSize);

        fmt::print(out, "      {{\"fifoPosition\": {}, \"address\": {}, \"size\": {}, \"type\": {}, \"offset\": {}}}{}\n",
            update.fifoPosition, update.address, update.dataSize, update.type, mem_offset,
            (j == frameInfo.numMemoryUpdates - 1) ? "" : ",");
    }
    fmt::print(out, "    ],\n");

    fmt::print(out, "    \"commands\": [\n");
    if (i == 0) {
      for (u32 reg = 0; reg < cpSize; ++reg) {
        if (cpData[reg] != 0) {
          fmt::print(out, "      {{\"type\": \"CP\", \"command\": {}, \"value\": {}}},\n", reg, cpData[reg]);
        }
      }
    }

    JsonCallback callback(cpmem, out);
    
    OpcodeDecoder::Run(fifoData.data(), fifoData.size(), callback);
    
    fmt::print(out, "      {{}}\n    ]\n  }}{}\n", i == header.frameCount - 1 ? "" : ",");
  }
  fmt::print(out, "]\n");

  return EXIT_SUCCESS;
}

} // namespace DolphinTool
