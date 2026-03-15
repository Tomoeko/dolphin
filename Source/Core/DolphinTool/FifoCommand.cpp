// Copyright 2024 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "DolphinTool/FifoCommand.h"

#include <cstdlib>
#include <iostream>
#include <fstream>
#include <vector>

#include <OptionParser.h>
#include <fmt/ostream.h>
#include <fmt/format.h>

#include "Common/CommonTypes.h"
#include "Common/Swap.h"
#include "VideoCommon/CPMemory.h"
#include "VideoCommon/OpcodeDecoding.h"

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
    fmt::print(m_out, "]}},\n");
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

int FifoCommand(const std::vector<std::string>& args)
{
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
