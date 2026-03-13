// Copyright 2018 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "DolphinQt/FIFO/FIFOAnalyzer.h"

#include <algorithm>
#include <bit>
#include <filesystem>
#include <fstream>
#include <map>
#include <ranges>
#include <set>
#include <sstream>
#include <utility>

#include <QFileDialog>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QMessageBox>
#include <QPushButton>
#include <QSplitter>
#include <QTextBrowser>
#include <QTreeWidget>
#include <QTreeWidgetItem>

#include "Common/Align.h"
#include "Common/Assert.h"
#include "Common/Image.h"
#include "Common/Swap.h"
#include "Core/FifoPlayer/FifoDataFile.h"
#include "Core/FifoPlayer/FifoPlayer.h"

#include "DolphinQt/QtUtils/NonDefaultQPushButton.h"
#include "DolphinQt/Settings.h"

#include "VideoCommon/BPMemory.h"
#include "VideoCommon/CPMemory.h"
#include "VideoCommon/OpcodeDecoding.h"
#include "VideoCommon/TextureCacheBase.h"
#include "VideoCommon/TextureDecoder.h"
#include "VideoCommon/XFStructs.h"

// Values range from 0 to number of frames - 1
constexpr int FRAME_ROLE = Qt::UserRole;
// Values range from 0 to number of parts - 1
constexpr int PART_START_ROLE = Qt::UserRole + 1;
// Values range from 1 to number of parts
constexpr int PART_END_ROLE = Qt::UserRole + 2;

FIFOAnalyzer::FIFOAnalyzer(FifoPlayer& fifo_player) : m_fifo_player(fifo_player)
{
  CreateWidgets();
  ConnectWidgets();

  UpdateTree();

  const auto& settings = Settings::GetQSettings();

  m_object_splitter->restoreState(
      settings.value(QStringLiteral("fifoanalyzer/objectsplitter")).toByteArray());
  m_search_splitter->restoreState(
      settings.value(QStringLiteral("fifoanalyzer/searchsplitter")).toByteArray());

  OnDebugFontChanged(Settings::Instance().GetDebugFont());
  connect(&Settings::Instance(), &Settings::DebugFontChanged, this,
          &FIFOAnalyzer::OnDebugFontChanged);
}

FIFOAnalyzer::~FIFOAnalyzer()
{
  auto& settings = Settings::GetQSettings();

  settings.setValue(QStringLiteral("fifoanalyzer/objectsplitter"), m_object_splitter->saveState());
  settings.setValue(QStringLiteral("fifoanalyzer/searchsplitter"), m_search_splitter->saveState());
}

void FIFOAnalyzer::CreateWidgets()
{
  m_tree_widget = new QTreeWidget;
  m_detail_list = new QListWidget;
  m_entry_detail_browser = new QTextBrowser;

  m_object_splitter = new QSplitter(Qt::Horizontal);

  m_object_splitter->addWidget(m_tree_widget);
  m_object_splitter->addWidget(m_detail_list);

  m_tree_widget->header()->hide();

  m_search_box = new QGroupBox(tr("Search Current Object"));
  m_search_edit = new QLineEdit;
  m_search_new = new NonDefaultQPushButton(tr("Search"));
  m_search_next = new NonDefaultQPushButton(tr("Next Match"));
  m_search_previous = new NonDefaultQPushButton(tr("Previous Match"));
  m_export_all = new NonDefaultQPushButton(tr("Export All"));
  m_export_scene = new NonDefaultQPushButton(tr("Export Scene"));
  m_search_label = new QLabel;

  m_search_next->setEnabled(false);
  m_search_previous->setEnabled(false);

  auto* box_layout = new QHBoxLayout;

  box_layout->addWidget(m_search_edit);
  box_layout->addWidget(m_search_new);
  box_layout->addWidget(m_search_next);
  box_layout->addWidget(m_search_previous);
  box_layout->addWidget(m_export_all);
  box_layout->addWidget(m_export_scene);
  box_layout->addWidget(m_search_label);

  m_search_box->setLayout(box_layout);

  m_search_box->setMaximumHeight(m_search_box->minimumSizeHint().height());

  m_search_splitter = new QSplitter(Qt::Vertical);

  m_search_splitter->addWidget(m_object_splitter);
  m_search_splitter->addWidget(m_entry_detail_browser);
  m_search_splitter->addWidget(m_search_box);

  auto* layout = new QHBoxLayout;
  layout->addWidget(m_search_splitter);

  setLayout(layout);
}

void FIFOAnalyzer::ConnectWidgets()
{
  connect(m_tree_widget, &QTreeWidget::itemSelectionChanged, this, &FIFOAnalyzer::UpdateDetails);
  connect(m_detail_list, &QListWidget::currentRowChanged, this, &FIFOAnalyzer::UpdateDescription);

  connect(m_search_edit, &QLineEdit::returnPressed, this, &FIFOAnalyzer::BeginSearch);
  connect(m_search_new, &QPushButton::clicked, this, &FIFOAnalyzer::BeginSearch);
  connect(m_search_next, &QPushButton::clicked, this, &FIFOAnalyzer::FindNext);
  connect(m_search_previous, &QPushButton::clicked, this, &FIFOAnalyzer::FindPrevious);
  connect(m_export_all, &QPushButton::clicked, this, &FIFOAnalyzer::ExportAll);
  connect(m_export_scene, &QPushButton::clicked, this, &FIFOAnalyzer::ExportScene);
}

void FIFOAnalyzer::Update()
{
  UpdateTree();
  UpdateDetails();
  UpdateDescription();
}

void FIFOAnalyzer::UpdateTree()
{
  m_tree_widget->clear();

  if (!m_fifo_player.IsPlaying())
  {
    m_tree_widget->addTopLevelItem(new QTreeWidgetItem({tr("No recording loaded.")}));
    return;
  }

  auto* recording_item = new QTreeWidgetItem({tr("Recording")});

  m_tree_widget->addTopLevelItem(recording_item);

  const auto* const file = m_fifo_player.GetFile();

  const u32 frame_count = file->GetFrameCount();

  for (u32 frame = 0; frame < frame_count; frame++)
  {
    auto* frame_item = new QTreeWidgetItem({tr("Frame %1").arg(frame)});

    recording_item->addChild(frame_item);

    const AnalyzedFrameInfo& frame_info = m_fifo_player.GetAnalyzedFrameInfo(frame);
    ASSERT(frame_info.parts.size() != 0);

    Common::EnumMap<u32, FramePartType::EFBCopy> part_counts;
    u32 part_start = 0;

    for (u32 part_nr = 0; part_nr < frame_info.parts.size(); part_nr++)
    {
      const auto& part = frame_info.parts[part_nr];

      const u32 part_type_nr = part_counts[part.m_type];
      part_counts[part.m_type]++;

      QTreeWidgetItem* object_item = nullptr;
      if (part.m_type == FramePartType::PrimitiveData)
        object_item = new QTreeWidgetItem({tr("Object %1").arg(part_type_nr)});
      else if (part.m_type == FramePartType::EFBCopy)
        object_item = new QTreeWidgetItem({tr("EFB copy %1").arg(part_type_nr)});
      // We don't create dedicated labels for FramePartType::Command;
      // those are grouped with the primitive

      if (object_item != nullptr)
      {
        frame_item->addChild(object_item);

        object_item->setData(0, FRAME_ROLE, frame);
        object_item->setData(0, PART_START_ROLE, part_start);
        object_item->setData(0, PART_END_ROLE, part_nr);

        part_start = part_nr + 1;
      }
    }

    // We shouldn't end on a Command (it should end with an EFB copy)
    ASSERT(part_start == frame_info.parts.size());
    // The counts we computed should match the frame's counts
    ASSERT(std::ranges::equal(frame_info.part_type_counts, part_counts));
  }
}

namespace
{
class DetailCallback : public OpcodeDecoder::Callback
{
public:
  explicit DetailCallback(const CPState& cpmem) : m_cpmem(cpmem) {}

  OPCODE_CALLBACK(void OnCP(const u8 command, const u32 value))
  {
    // Note: No need to update m_cpmem as it already has the final value for this object

    const auto [name, desc] = GetCPRegInfo(command, value);
    ASSERT(!name.empty());

    text = QStringLiteral("CP  %1  %2  %3")
               .arg(command, 2, 16, QLatin1Char('0'))
               .arg(value, 8, 16, QLatin1Char('0'))
               .arg(QString::fromStdString(name));
  }

  OPCODE_CALLBACK(void OnXF(const u16 address, const u8 count, const u8* data))
  {
    const auto [name, desc] = GetXFTransferInfo(address, count, data);
    ASSERT(!name.empty());

    const u32 command = address | ((count - 1) << 16);

    text = QStringLiteral("XF  %1  ").arg(command, 8, 16, QLatin1Char('0'));

    for (u8 i = 0; i < count; i++)
    {
      const u32 value = Common::swap32(&data[i * 4]);

      text += QStringLiteral("%1 ").arg(value, 8, 16, QLatin1Char('0'));
    }

    text += QStringLiteral("  ") + QString::fromStdString(name);
  }

  OPCODE_CALLBACK(void OnBP(const u8 command, const u32 value))
  {
    const auto [name, desc] = GetBPRegInfo(command, value);
    ASSERT(!name.empty());

    text = QStringLiteral("BP  %1  %2  %3")
               .arg(command, 2, 16, QLatin1Char('0'))
               .arg(value, 6, 16, QLatin1Char('0'))
               .arg(QString::fromStdString(name));
  }
  OPCODE_CALLBACK(void OnIndexedLoad(const CPArray array, const u32 index, const u16 address,
                                     const u8 size))
  {
    const auto [desc, written] = GetXFIndexedLoadInfo(array, index, address, size);
    text = QStringLiteral("LOAD INDX %1   %2")
               .arg(QString::fromStdString(fmt::to_string(array)))
               .arg(QString::fromStdString(desc));
  }
  OPCODE_CALLBACK(void OnPrimitiveCommand(const OpcodeDecoder::Primitive primitive, const u8 vat,
                                          const u32 vertex_size, const u16 num_vertices,
                                          const u8* vertex_data))
  {
    const auto name = fmt::to_string(primitive);

    // Note that vertex_count is allowed to be 0, with no special treatment
    // (another command just comes right after the current command, with no vertices in between)
    const u32 object_prim_size = num_vertices * vertex_size;

    const u8 opcode =
        0x80 | std::to_underlying(primitive) << OpcodeDecoder::GX_PRIMITIVE_SHIFT | vat;
    text = QStringLiteral("PRIMITIVE %1 (%2)  %3 vertices %4 bytes/vertex %5 total bytes")
               .arg(QString::fromStdString(name))
               .arg(opcode, 2, 16, QLatin1Char('0'))
               .arg(num_vertices)
               .arg(vertex_size)
               .arg(object_prim_size);

    // It's not really useful to have a massive unreadable hex string for the object primitives.
    // Put it in the description instead.

// #define INCLUDE_HEX_IN_PRIMITIVES
#ifdef INCLUDE_HEX_IN_PRIMITIVES
    text += QStringLiteral("   ");
    for (u32 i = 0; i < object_prim_size; i++)
    {
      text += QStringLiteral("%1").arg(vertex_data[i], 2, 16, QLatin1Char('0'));
    }
#endif
  }

  OPCODE_CALLBACK(void OnDisplayList(const u32 address, const u32 size))
  {
    text = QObject::tr("Call display list at %1 with size %2")
               .arg(address, 8, 16, QLatin1Char('0'))
               .arg(size, 8, 16, QLatin1Char('0'));
  }

  OPCODE_CALLBACK(void OnNop(const u32 count))
  {
    if (count > 1)
      text = QStringLiteral("NOP (%1x)").arg(count);
    else
      text = QStringLiteral("NOP");
  }

  OPCODE_CALLBACK(void OnUnknown(u8 opcode, const u8* data))
  {
    using OpcodeDecoder::Opcode;
    if (static_cast<Opcode>(opcode) == Opcode::GX_CMD_UNKNOWN_METRICS)
      text = QStringLiteral("GX_CMD_UNKNOWN_METRICS");
    else if (static_cast<Opcode>(opcode) == Opcode::GX_CMD_INVL_VC)
      text = QStringLiteral("GX_CMD_INVL_VC");
    else
      text = QStringLiteral("Unknown opcode %1").arg(opcode, 2, 16);
  }

  OPCODE_CALLBACK(void OnCommand(const u8* data, u32 size)) {}

  OPCODE_CALLBACK(CPState& GetCPState()) { return m_cpmem; }

  QString text;
  CPState m_cpmem;
};
}  // namespace

void FIFOAnalyzer::UpdateDetails()
{
  // Clearing the detail list can update the selection, which causes UpdateDescription to be called
  // immediately.  However, the object data offsets have not been recalculated yet, which can cause
  // the wrong data to be used, potentially leading to out of bounds data or other bad things.
  // Clear m_object_data_offsets first, so that UpdateDescription exits immediately.
  m_object_data_offsets.clear();
  m_detail_list->clear();
  m_search_results.clear();
  m_search_next->setEnabled(false);
  m_search_previous->setEnabled(false);
  m_search_label->clear();

  if (!m_fifo_player.IsPlaying())
    return;

  const auto items = m_tree_widget->selectedItems();

  if (items.isEmpty() || items[0]->data(0, PART_START_ROLE).isNull())
    return;

  const u32 frame_nr = items[0]->data(0, FRAME_ROLE).toUInt();
  const u32 start_part_nr = items[0]->data(0, PART_START_ROLE).toUInt();
  const u32 end_part_nr = items[0]->data(0, PART_END_ROLE).toUInt();

  const AnalyzedFrameInfo& frame_info = m_fifo_player.GetAnalyzedFrameInfo(frame_nr);
  const auto& fifo_frame = m_fifo_player.GetFile()->GetFrame(frame_nr);

  const u32 object_start = frame_info.parts[start_part_nr].m_start;
  const u32 object_end = frame_info.parts[end_part_nr].m_end;
  const u32 object_size = object_end - object_start;

  u32 object_offset = 0;
  // NOTE: object_info.m_cpmem is the state of cpmem _after_ all of the commands in this object.
  // However, it doesn't matter that it doesn't match the start, since it will match by the time
  // primitives are reached.
  auto callback = DetailCallback(frame_info.parts[end_part_nr].m_cpmem);

  while (object_offset < object_size)
  {
    const u32 start_offset = object_offset;
    m_object_data_offsets.push_back(start_offset);

    object_offset += OpcodeDecoder::RunCommand(&fifo_frame.fifoData[object_start + start_offset],
                                               object_size - start_offset, callback);

    QString new_label =
        QStringLiteral("%1:  ").arg(object_start + start_offset, 8, 16, QLatin1Char('0')) +
        callback.text;
    m_detail_list->addItem(new_label);
  }

  // Needed to ensure the description updates when changing objects
  m_detail_list->setCurrentRow(0);
}

void FIFOAnalyzer::BeginSearch()
{
  const QString search_str = m_search_edit->text();

  if (!m_fifo_player.IsPlaying())
    return;

  const auto items = m_tree_widget->selectedItems();

  if (items.isEmpty() || items[0]->data(0, FRAME_ROLE).isNull() ||
      items[0]->data(0, PART_START_ROLE).isNull())
  {
    m_search_label->setText(tr("Invalid search parameters (no object selected)"));
    return;
  }

  // Having PART_START_ROLE indicates that this is valid
  const int object_idx = items[0]->parent()->indexOfChild(items[0]);

  // TODO: Remove even string length limit
  if (search_str.length() % 2)
  {
    m_search_label->setText(tr("Invalid search string (only even string lengths supported)"));
    return;
  }

  const size_t length = search_str.length() / 2;

  std::vector<u8> search_val;

  for (size_t i = 0; i < length; i++)
  {
    const QString byte_str = search_str.mid(static_cast<int>(i * 2), 2);

    bool good;
    u8 value = byte_str.toUInt(&good, 16);

    if (!good)
    {
      m_search_label->setText(tr("Invalid search string (couldn't convert to number)"));
      return;
    }

    search_val.push_back(value);
  }

  m_search_results.clear();

  const u32 frame_nr = items[0]->data(0, FRAME_ROLE).toUInt();
  const u32 start_part_nr = items[0]->data(0, PART_START_ROLE).toUInt();
  const u32 end_part_nr = items[0]->data(0, PART_END_ROLE).toUInt();

  const AnalyzedFrameInfo& frame_info = m_fifo_player.GetAnalyzedFrameInfo(frame_nr);
  const FifoFrameInfo& fifo_frame = m_fifo_player.GetFile()->GetFrame(frame_nr);

  const u32 object_start = frame_info.parts[start_part_nr].m_start;
  const u32 object_end = frame_info.parts[end_part_nr].m_end;
  const u32 object_size = object_end - object_start;

  const u8* const object = &fifo_frame.fifoData[object_start];

  // TODO: Support searching for bit patterns
  for (u32 cmd_nr = 0; cmd_nr < m_object_data_offsets.size(); cmd_nr++)
  {
    const u32 cmd_start = m_object_data_offsets[cmd_nr];
    const u32 cmd_end = (cmd_nr + 1 == m_object_data_offsets.size()) ?
                            object_size :
                            m_object_data_offsets[cmd_nr + 1];

    const u8* const cmd_start_ptr = &object[cmd_start];
    const u8* const cmd_end_ptr = &object[cmd_end];

    for (const u8* ptr = cmd_start_ptr; ptr < cmd_end_ptr - length + 1; ptr++)
    {
      if (std::equal(search_val.begin(), search_val.end(), ptr))
      {
        m_search_results.emplace_back(frame_nr, object_idx, cmd_nr);
        break;
      }
    }
  }

  ShowSearchResult(0);

  m_search_label->setText(
      tr("Found %1 results for \"%2\"").arg(m_search_results.size()).arg(search_str));
}

void FIFOAnalyzer::FindNext()
{
  const int index = m_detail_list->currentRow();
  ASSERT(index >= 0);

  const auto next_result = std::ranges::find_if(
      m_search_results, [index](auto& result) { return result.m_cmd > static_cast<u32>(index); });
  if (next_result != m_search_results.end())
  {
    ShowSearchResult(next_result - m_search_results.begin());
  }
}

void FIFOAnalyzer::FindPrevious()
{
  const int index = m_detail_list->currentRow();
  ASSERT(index >= 0);

  const auto prev_result =
      std::ranges::find_if(m_search_results | std::views::reverse, [index](auto& result) {
        return result.m_cmd < static_cast<u32>(index);
      });
  if (prev_result != m_search_results.rend())
  {
    ShowSearchResult((m_search_results.rend() - prev_result) - 1);
  }
}

void FIFOAnalyzer::ShowSearchResult(const size_t index)
{
  if (m_search_results.empty())
    return;

  if (index >= m_search_results.size())
  {
    ShowSearchResult(m_search_results.size() - 1);
    return;
  }

  const auto& result = m_search_results[index];

  QTreeWidgetItem* object_item =
      m_tree_widget->topLevelItem(0)->child(result.m_frame)->child(result.m_object_idx);

  m_tree_widget->setCurrentItem(object_item);
  m_detail_list->setCurrentRow(result.m_cmd);

  m_search_next->setEnabled(index + 1 < m_search_results.size());
  m_search_previous->setEnabled(index > 0);
}

namespace
{
// TODO: Not sure whether we should bother translating the descriptions
class DescriptionCallback : public OpcodeDecoder::Callback
{
public:
  explicit DescriptionCallback(const CPState& cpmem) : m_cpmem(cpmem) {}

  OPCODE_CALLBACK(void OnBP(const u8 command, const u32 value))
  {
    const auto [name, desc] = GetBPRegInfo(command, value);
    ASSERT(!name.empty());

    text = QObject::tr("BP register ");
    text += QString::fromStdString(name);
    text += QLatin1Char{'\n'};

    if (desc.empty())
      text += QObject::tr("No description available");
    else
      text += QString::fromStdString(desc);
  }

  OPCODE_CALLBACK(void OnCP(const u8 command, const u32 value))
  {
    // Note: No need to update m_cpmem as it already has the final value for this object

    const auto [name, desc] = GetCPRegInfo(command, value);
    ASSERT(!name.empty());

    text = QObject::tr("CP register ");
    text += QString::fromStdString(name);
    text += QLatin1Char{'\n'};

    if (desc.empty())
      text += QObject::tr("No description available");
    else
      text += QString::fromStdString(desc);
  }

  OPCODE_CALLBACK(void OnXF(const u16 address, const u8 count, const u8* data))
  {
    const auto [name, desc] = GetXFTransferInfo(address, count, data);
    ASSERT(!name.empty());

    text = QObject::tr("XF register ");
    text += QString::fromStdString(name);
    text += QLatin1Char{'\n'};

    if (desc.empty())
      text += QObject::tr("No description available");
    else
      text += QString::fromStdString(desc);
  }

  OPCODE_CALLBACK(void OnIndexedLoad(const CPArray array, const u32 index, const u16 address,
                                     const u8 size))
  {
    const auto [desc, written] = GetXFIndexedLoadInfo(array, index, address, size);

    text = QString::fromStdString(desc);
    text += QLatin1Char{'\n'};
    switch (array)
    {
    case CPArray::XF_A:
      text += QObject::tr("Usually used for position matrices");
      break;
    case CPArray::XF_B:
      // i18n: A normal matrix is a matrix used for transforming normal vectors. The word "normal"
      // does not have its usual meaning here, but rather the meaning of "perpendicular to a
      // surface".
      text += QObject::tr("Usually used for normal matrices");
      break;
    case CPArray::XF_C:
      // i18n: Tex coord is short for texture coordinate
      text += QObject::tr("Usually used for tex coord matrices");
      break;
    case CPArray::XF_D:
      text += QObject::tr("Usually used for light objects");
      break;
    default:
      break;
    }
    text += QLatin1Char{'\n'};
    text += QString::fromStdString(written);
  }

  OPCODE_CALLBACK(void OnPrimitiveCommand(OpcodeDecoder::Primitive primitive, u8 vat,
                                          const u32 vertex_size, const u16 num_vertices,
                                          const u8* vertex_data))
  {
    const auto name = fmt::format("{} VAT {}", primitive, vat);

    // i18n: In this context, a primitive means a point, line, triangle or rectangle.
    // Do not translate the word primitive as if it was an adjective.
    text = QObject::tr("Primitive %1").arg(QString::fromStdString(name));
    text += QLatin1Char{'\n'};

    const auto& vtx_desc = m_cpmem.vtx_desc;
    const auto& vtx_attr = m_cpmem.vtx_attr[vat];

    u32 i = 0;
    const auto process_component = [&](const VertexComponentFormat cformat, ComponentFormat format,
                                       const u32 non_indexed_count, const u32 indexed_count = 1) {
      u32 count;
      if (cformat == VertexComponentFormat::NotPresent)
        return;
      else if (cformat == VertexComponentFormat::Index8)
      {
        format = ComponentFormat::UByte;
        count = indexed_count;
      }
      else if (cformat == VertexComponentFormat::Index16)
      {
        format = ComponentFormat::UShort;
        count = indexed_count;
      }
      else
      {
        count = non_indexed_count;
      }

      const u32 component_size = GetElementSize(format);
      for (u32 j = 0; j < count; j++)
      {
        for (u32 component_off = 0; component_off < component_size; component_off++)
        {
          text += QStringLiteral("%1").arg(vertex_data[i + component_off], 2, 16, QLatin1Char('0'));
        }
        if (format == ComponentFormat::Float)
        {
          const float value = std::bit_cast<float>(Common::swap32(&vertex_data[i]));
          text += QStringLiteral(" (%1)").arg(value);
        }
        i += component_size;
        text += QLatin1Char{' '};
      }
      text += QLatin1Char{' '};
    };
    const auto process_simple_component = [&](const u32 size) {
      for (u32 component_off = 0; component_off < size; component_off++)
      {
        text += QStringLiteral("%1").arg(vertex_data[i + component_off], 2, 16, QLatin1Char('0'));
      }
      i += size;
      text += QLatin1Char{' '};
      text += QLatin1Char{' '};
    };

    for (u32 vertex_num = 0; vertex_num < num_vertices; vertex_num++)
    {
      ASSERT(i == vertex_num * vertex_size);

      text += QLatin1Char{'\n'};
      if (vtx_desc.low.PosMatIdx)
        process_simple_component(1);
      for (auto texmtxidx : vtx_desc.low.TexMatIdx)
      {
        if (texmtxidx)
          process_simple_component(1);
      }
      process_component(vtx_desc.low.Position, vtx_attr.g0.PosFormat,
                        vtx_attr.g0.PosElements == CoordComponentCount::XY ? 2 : 3);
      const u32 normal_component_count =
          vtx_desc.low.Normal == VertexComponentFormat::Direct ? 3 : 1;
      const u32 normal_elements = vtx_attr.g0.NormalElements == NormalComponentCount::NTB ? 3 : 1;
      process_component(vtx_desc.low.Normal, vtx_attr.g0.NormalFormat,
                        normal_component_count * normal_elements,
                        vtx_attr.g0.NormalIndex3 ? normal_elements : 1);
      for (u32 c = 0; c < vtx_desc.low.Color.Size(); c++)
      {
        static constexpr Common::EnumMap<u32, ColorFormat::RGBA8888> component_sizes = {
            2,  // RGB565
            3,  // RGB888
            4,  // RGB888x
            2,  // RGBA4444
            3,  // RGBA6666
            4,  // RGBA8888
        };
        switch (vtx_desc.low.Color[c])
        {
        case VertexComponentFormat::Index8:
          process_simple_component(1);
          break;
        case VertexComponentFormat::Index16:
          process_simple_component(2);
          break;
        case VertexComponentFormat::Direct:
          process_simple_component(component_sizes[vtx_attr.GetColorFormat(c)]);
          break;
        case VertexComponentFormat::NotPresent:
          break;
        }
      }
      for (u32 t = 0; t < vtx_desc.high.TexCoord.Size(); t++)
      {
        process_component(vtx_desc.high.TexCoord[t], vtx_attr.GetTexFormat(t),
                          vtx_attr.GetTexElements(t) == TexComponentCount::ST ? 2 : 1);
      }
    }
  }

  OPCODE_CALLBACK(void OnDisplayList(u32 address, u32 size))
  {
    text = QObject::tr("No description available");
  }

  OPCODE_CALLBACK(void OnNop(u32 count)) { text = QObject::tr("No description available"); }
  OPCODE_CALLBACK(void OnUnknown(u8 opcode, const u8* data))
  {
    text = QObject::tr("No description available");
  }

  OPCODE_CALLBACK(void OnCommand(const u8* data, u32 size)) {}

  OPCODE_CALLBACK(CPState& GetCPState()) { return m_cpmem; }

  QString text;
  CPState m_cpmem;
};
}  // namespace

void FIFOAnalyzer::UpdateDescription()
{
  m_entry_detail_browser->clear();

  if (!m_fifo_player.IsPlaying())
    return;

  const auto items = m_tree_widget->selectedItems();

  if (items.isEmpty() || m_object_data_offsets.empty())
    return;

  if (items[0]->data(0, FRAME_ROLE).isNull() || items[0]->data(0, PART_START_ROLE).isNull())
    return;

  const u32 frame_nr = items[0]->data(0, FRAME_ROLE).toUInt();
  const u32 start_part_nr = items[0]->data(0, PART_START_ROLE).toUInt();
  const u32 end_part_nr = items[0]->data(0, PART_END_ROLE).toUInt();
  const u32 entry_nr = m_detail_list->currentRow();

  const AnalyzedFrameInfo& frame_info = m_fifo_player.GetAnalyzedFrameInfo(frame_nr);
  const FifoFrameInfo& fifo_frame = m_fifo_player.GetFile()->GetFrame(frame_nr);

  const u32 object_start = frame_info.parts[start_part_nr].m_start;
  const u32 object_end = frame_info.parts[end_part_nr].m_end;
  const u32 object_size = object_end - object_start;
  const u32 entry_start = m_object_data_offsets[entry_nr];

  auto callback = DescriptionCallback(frame_info.parts[end_part_nr].m_cpmem);
  OpcodeDecoder::RunCommand(&fifo_frame.fifoData[object_start + entry_start],
                            object_size - entry_start, callback);
  m_entry_detail_browser->setText(callback.text);
}

void FIFOAnalyzer::OnDebugFontChanged(const QFont& font)
{
  m_detail_list->setFont(font);
  m_entry_detail_browser->setFont(font);
}

namespace
{
// Stateful callback that tracks GX state and produces per-object summaries
// for NW4R layout debugging
class SummaryCallback : public OpcodeDecoder::Callback
{
public:
  explicit SummaryCallback(const CPState& cpmem) : m_cpmem(cpmem) {}

  void Reset()
  {
    m_has_pos_matrix = false;
    m_pos_tx = 0.0f; m_pos_ty = 0.0f; m_pos_tz = 0.0f;
    m_pos_sx = 1.0f; m_pos_sy = 1.0f;
    // Initialize position matrix table to identity (up to 256 floats)
    for (int i = 0; i < 268; i++) m_pos_matrices[i] = 0.0f;
    for (int i = 0; i < 64; i += 3)
    {
      m_pos_matrices[i*4 + 0] = 1.0f; // m00
      if (i+1 < 64) m_pos_matrices[(i+1)*4 + 1] = 1.0f; // m11
      if (i+2 < 64) m_pos_matrices[(i+2)*4 + 2] = 1.0f; // m22
    }
    m_genmode_set = false;
    m_num_tev_stages = 0;
    for (int i = 0; i < 8; i++)
    {
      m_tex_set[i] = false;
      m_tex_width[i] = 0; m_tex_height[i] = 0;
      m_tex_fmt[i] = 0; m_tex_addr[i] = 0;
      m_tex_wrap_set[i] = false;
      m_tex_wrap_s[i] = 0; m_tex_wrap_t[i] = 0;
      m_texmtxinfo_set[i] = false;
      m_texmtxinfo[i] = 0;
      m_texmtx_set[i] = false;
      for (int j = 0; j < 8; j++) m_texmtx[i][j] = 0.0f;
    }
    m_num_texgens = 0;
    m_num_texgens_set = false;
    for (int i = 0; i < 4; i++)
    {
      m_tev_color_ra[i] = 0; m_tev_color_bg[i] = 0;
      m_tev_color_set[i] = false;
      m_tev_konst_ra[i] = 0; m_tev_konst_bg[i] = 0;
      m_tev_konst_set[i] = false;
    }
    for (int i = 0; i < 16; i++)
    {
      m_tev_color_env[i] = 0; m_tev_alpha_env[i] = 0;
      m_tev_env_set[i] = false;
    }
    m_tref_set = false;
    for (int i = 0; i < 8; i++) m_tref[i] = 0;
    m_blend_set = false; m_blend_val = 0;
    // Scissor
    m_scissor_set = false;
    m_scissor_tl = 0; m_scissor_br = 0;
    // KSEL (konst color sel)
    for (int i = 0; i < 8; i++) { m_ksel[i] = 0; m_ksel_set[i] = false; }
    // SU coord scale
    for (int i = 0; i < 8; i++) { m_su_ssize[i] = 0; m_su_tsize[i] = 0; m_su_set[i] = false; }
    m_prim_count = 0;
    m_primitives.clear();
    m_chan0_color_src = -1;
    m_chan0_alpha_src = -1;
    // Viewport & Projection (persistent state, do NOT reset per-object)
    // These are only reset once at frame start via ResetGlobalState()
  }

  // Call once per frame to reset viewport/projection state
  void ResetGlobalState()
  {
    m_vp_set = false;
    m_vp_wd = 304.0f; m_vp_ht = -228.0f;  // Defaults for 608x456
    m_vp_x_orig = 304.0f; m_vp_y_orig = 228.0f;
    m_proj_set = false;
    m_proj_type = 1;  // Orthographic
    for (int i = 0; i < 6; i++) m_proj_params[i] = 0.0f;
  }

  OPCODE_CALLBACK(void OnXF(const u16 address, const u8 count, const u8* data))
  {
    // Track position matrix writes (XF memory 0x0000-0x00FF = 256 floats)
    if (address < 0x0100)
    {
      m_has_pos_matrix = true;
      for (int i = 0; i < count && (address + i) < 0x0100; i++)
      {
        m_pos_matrices[address + i] = std::bit_cast<float>(Common::swap32(&data[i * 4]));
      }

      // Convenience aliases for PNMTX0 backward compat
      m_pos_sx = m_pos_matrices[0]; m_pos_tx = m_pos_matrices[3];
      m_pos_sy = m_pos_matrices[5]; m_pos_ty = m_pos_matrices[7];
      m_pos_tz = m_pos_matrices[11];
    }
    // Track GX viewport (XF 0x101A-0x101F: wd, ht, zRange, xOrig, yOrig, farZ)
    // The viewport transform maps clip coords to screen pixels:
    //   screen_x = clip_x * vp_wd + vp_xOrig
    //   screen_y = clip_y * vp_ht + vp_yOrig
    if (address <= XFMEM_SETVIEWPORT && address + count > XFMEM_SETVIEWPORT)
    {
      u32 off = (XFMEM_SETVIEWPORT - address);
      u32 avail = count - off;
      auto rf = [&](u32 idx) -> float {
        return std::bit_cast<float>(Common::swap32(&data[(off + idx) * 4]));
      };
      if (avail >= 6)
      {
        m_vp_wd = rf(0);     // viewport half-width (typically 304 for 608-wide)
        m_vp_ht = rf(1);     // viewport half-height (typically -228 for 456-tall, negative because Y is inverted)
        m_vp_x_orig = rf(3); // viewport X origin (typically 304)
        m_vp_y_orig = rf(4); // viewport Y origin (typically 228)
        m_vp_set = true;
      }
    }
    // Track GX projection (XF 0x1020-0x1026: type + 6 params)
    // For orthographic: clip_x = pos_x * p[0] + p[1], clip_y = pos_y * p[2] + p[3]
    if (address <= XFMEM_SETPROJECTION && address + count > XFMEM_SETPROJECTION)
    {
      u32 off = (XFMEM_SETPROJECTION - address);
      u32 avail = count - off;
      auto rf = [&](u32 idx) -> float {
        return std::bit_cast<float>(Common::swap32(&data[(off + idx) * 4]));
      };
      if (avail >= 7)
      {
        for (int i = 0; i < 6; i++) m_proj_params[i] = rf(i);
        m_proj_type = Common::swap32(&data[(off + 6) * 4]);
        m_proj_set = true;
      }
    }
    // Track texture matrices (XF memory 0x0078-0x009F for TexMtx0-7)
    // Each texture matrix is 2x4 = 8 floats, stored as rows 30-61 of position matrices
    // TexMtx0 starts at XF addr 0x0078 (row 30), TexMtx1 at 0x0084 (row 33), etc.
    // Layout: each takes 8 floats but is spaced 3 rows apart (12 floats)
    for (int i = 0; i < 8; i++)
    {
      u16 mtx_addr = 0x0078 + i * 12;  // 3 rows * 4 floats per TexMtx
      if (address <= mtx_addr && address + count > mtx_addr)
      {
        u32 offset_in_data = (mtx_addr - address);
        u32 avail = count - offset_in_data;
        if (avail >= 8)
        {
          m_texmtx_set[i] = true;
          for (int j = 0; j < 8; j++)
          {
            m_texmtx[i][j] = std::bit_cast<float>(Common::swap32(&data[(offset_in_data + j) * 4]));
          }
        }
      }
    }
    // Track number of tex gens
    if (address == XFMEM_SETNUMTEXGENS)
    {
      u32 val = Common::swap32(&data[0]);
      m_num_texgens = val & 0xF;
      m_num_texgens_set = true;
    }
    // Track TexCoordGen info (XFMEM_SETTEXMTXINFO = 0x1040-0x1047)
    if (address >= XFMEM_SETTEXMTXINFO && address < XFMEM_SETTEXMTXINFO + 8)
    {
      for (u8 i = 0; i < count && (address - XFMEM_SETTEXMTXINFO + i) < 8; i++)
      {
        int idx = (address - XFMEM_SETTEXMTXINFO) + i;
        m_texmtxinfo[idx] = Common::swap32(&data[i * 4]);
        m_texmtxinfo_set[idx] = true;
      }
    }
    // Track color channel config
    if (address == 0x100e)  // XFMEM_SETCHAN0_COLOR
    {
      u32 val = Common::swap32(&data[0]);
      m_chan0_color_src = (val & 1);  // 0=material reg, 1=vertex color
    }
    if (address == 0x1010)  // XFMEM_SETCHAN0_ALPHA
    {
      u32 val = Common::swap32(&data[0]);
      m_chan0_alpha_src = (val & 1);
    }
  }

  OPCODE_CALLBACK(void OnBP(const u8 command, const u32 value))
  {
    // GenMode — number of TEV stages
    if (command == BPMEM_GENMODE)
    {
      GenMode gm; gm.hex = value;
      m_num_tev_stages = gm.numtevstages + 1;
      m_genmode_set = true;
    }
    // Texture Image0 — width, height, format (units 0-3)
    if (command >= BPMEM_TX_SETIMAGE0 && command < BPMEM_TX_SETIMAGE0 + 4)
    {
      int unit = command - BPMEM_TX_SETIMAGE0;
      TexImage0 ti; ti.hex = value;
      m_tex_set[unit] = true;
      m_tex_width[unit] = ti.width + 1;
      m_tex_height[unit] = ti.height + 1;
      m_tex_fmt[unit] = static_cast<u32>(ti.format.Value());
    }
    // Texture Image0 — units 4-7
    if (command >= BPMEM_TX_SETIMAGE0_4 && command < BPMEM_TX_SETIMAGE0_4 + 4)
    {
      int unit = command - BPMEM_TX_SETIMAGE0_4 + 4;
      TexImage0 ti; ti.hex = value;
      m_tex_set[unit] = true;
      m_tex_width[unit] = ti.width + 1;
      m_tex_height[unit] = ti.height + 1;
      m_tex_fmt[unit] = static_cast<u32>(ti.format.Value());
    }
    // Texture Image3 — source address (units 0-3)
    if (command >= BPMEM_TX_SETIMAGE3 && command < BPMEM_TX_SETIMAGE3 + 4)
    {
      int unit = command - BPMEM_TX_SETIMAGE3;
      TexImage3 ti; ti.hex = value;
      m_tex_addr[unit] = ti.image_base << 5;
    }
    // Texture Image3 — units 4-7
    if (command >= BPMEM_TX_SETIMAGE3_4 && command < BPMEM_TX_SETIMAGE3_4 + 4)
    {
      int unit = command - BPMEM_TX_SETIMAGE3_4 + 4;
      TexImage3 ti; ti.hex = value;
      m_tex_addr[unit] = ti.image_base << 5;
    }
    // TEV color registers (RA and BG pairs)
    if (command >= BPMEM_TEV_COLOR_RA && command < BPMEM_TEV_COLOR_RA + 8)
    {
      int idx = (command - BPMEM_TEV_COLOR_RA) / 2;
      bool is_bg = ((command - BPMEM_TEV_COLOR_RA) % 2) == 1;
      if (idx < 4)
      {
        bool is_konst = (value >> 23) & 1;
        if (is_konst)
        {
          // Konst type register write
          m_tev_konst_set[idx] = true;
          if (is_bg) m_tev_konst_bg[idx] = value;
          else m_tev_konst_ra[idx] = value;
        }
        else
        {
          // Standard color register write — these are the actual c0/c1/c2 values
          m_tev_color_set[idx] = true;
          if (is_bg) m_tev_color_bg[idx] = value;
          else m_tev_color_ra[idx] = value;
        }
      }
    }
    // TEV stage color/alpha environment
    if (command >= BPMEM_TEV_COLOR_ENV && command < BPMEM_TEV_COLOR_ENV + 32)
    {
      int offset = command - BPMEM_TEV_COLOR_ENV;
      int stage = offset / 2;
      bool is_alpha = (offset % 2) == 1;
      if (stage < 16)
      {
        m_tev_env_set[stage] = true;
        if (is_alpha) m_tev_alpha_env[stage] = value;
        else m_tev_color_env[stage] = value;
      }
    }
    // TREF — texture/rasterized color channel mapping
    if (command >= BPMEM_TREF && command < BPMEM_TREF + 8)
    {
      int idx = command - BPMEM_TREF;
      m_tref[idx] = value;
      m_tref_set = true;
    }
    // Texture wrap modes (BPMEM_TX_SETMODE0, units 0-3)
    if (command >= BPMEM_TX_SETMODE0 && command < BPMEM_TX_SETMODE0 + 4)
    {
      int unit = command - BPMEM_TX_SETMODE0;
      TexMode0 tm; tm.hex = value;
      m_tex_wrap_set[unit] = true;
      m_tex_wrap_s[unit] = static_cast<u32>(tm.wrap_s.Value());
      m_tex_wrap_t[unit] = static_cast<u32>(tm.wrap_t.Value());
    }
    // Texture wrap modes (units 4-7)
    if (command >= BPMEM_TX_SETMODE0_4 && command < BPMEM_TX_SETMODE0_4 + 4)
    {
      int unit = command - BPMEM_TX_SETMODE0_4 + 4;
      TexMode0 tm; tm.hex = value;
      m_tex_wrap_set[unit] = true;
      m_tex_wrap_s[unit] = static_cast<u32>(tm.wrap_s.Value());
      m_tex_wrap_t[unit] = static_cast<u32>(tm.wrap_t.Value());
    }
    // Blend mode
    if (command == BPMEM_BLENDMODE)
    {
      m_blend_set = true;
      m_blend_val = value;
    }
    // Scissor rectangle
    if (command == BPMEM_SCISSORTL)
    {
      m_scissor_tl = value;
      m_scissor_set = true;
    }
    if (command == BPMEM_SCISSORBR)
    {
      m_scissor_br = value;
      m_scissor_set = true;
    }
    // Konst color selection (KSEL registers 0xF6-0xFD)
    if (command >= BPMEM_TEV_KSEL && command < BPMEM_TEV_KSEL + 8)
    {
      int idx = command - BPMEM_TEV_KSEL;
      m_ksel[idx] = value;
      m_ksel_set[idx] = true;
    }
    // SU coord scale (SSIZE at 0x30,0x32,...0x3E; TSIZE at 0x31,0x33,...0x3F)
    if (command >= BPMEM_SU_SSIZE && command < BPMEM_SU_SSIZE + 16)
    {
      int offset = command - BPMEM_SU_SSIZE;
      int unit = offset / 2;
      if (unit < 8)
      {
        m_su_set[unit] = true;
        if (offset % 2 == 0)
          m_su_ssize[unit] = value;
        else
          m_su_tsize[unit] = value;
      }
    }
  }

  OPCODE_CALLBACK(void OnPrimitiveCommand(const OpcodeDecoder::Primitive primitive, const u8 vat,
                                          const u32 vertex_size, const u16 num_vertices,
                                          const u8* vertex_data))
  {
    m_prim_count++;

    PrimitiveGroup pg;
    pg.type = primitive;

    // Parse vertex data to extract positions and colors
    const auto& vtx_desc = m_cpmem.vtx_desc;
    const auto& vtx_attr = m_cpmem.vtx_attr[vat];

    for (u32 v = 0; v < num_vertices; v++)
    {
      VertexInfo vi{};
      u32 off = v * vertex_size;

      // Read pos matrix idx
      vi.pos_idx = m_cpmem.matrix_index_a.PosNormalMtxIdx; // Default
      if (vtx_desc.low.PosMatIdx)
      {
        vi.pos_idx = vertex_data[off];
        off += 1;
      }
      for (auto idx : vtx_desc.low.TexMatIdx)
      {
        if (idx) off += 1;
      }

      // Read position
      if (vtx_desc.low.Position == VertexComponentFormat::Direct)
      {
        bool xyz = (vtx_attr.g0.PosElements == CoordComponentCount::XYZ);
        if (vtx_attr.g0.PosFormat == ComponentFormat::Float)
        {
          vi.px = std::bit_cast<float>(Common::swap32(&vertex_data[off])); off += 4;
          vi.py = std::bit_cast<float>(Common::swap32(&vertex_data[off])); off += 4;
          if (xyz)
          {
            vi.pz = std::bit_cast<float>(Common::swap32(&vertex_data[off])); off += 4;
          }
          vi.has_pos = true;
        }
        else
        {
          // Skip non-float positions
          u32 count = xyz ? 3 : 2;
          off += count * GetElementSize(vtx_attr.g0.PosFormat);
        }
      }
      else if (vtx_desc.low.Position != VertexComponentFormat::NotPresent)
      {
        // Indexed — skip
        off += (vtx_desc.low.Position == VertexComponentFormat::Index8) ? 1 : 2;
      }

      // Skip normals
      if (vtx_desc.low.Normal != VertexComponentFormat::NotPresent)
      {
        if (vtx_desc.low.Normal == VertexComponentFormat::Direct)
        {
          u32 ncount = 3;
          if (vtx_attr.g0.NormalElements == NormalComponentCount::NTB) ncount = 9;
          off += ncount * GetElementSize(vtx_attr.g0.NormalFormat);
        }
        else
        {
          u32 idx_size = (vtx_desc.low.Normal == VertexComponentFormat::Index8) ? 1 : 2;
          u32 idx_count = 1;
          if (vtx_attr.g0.NormalElements == NormalComponentCount::NTB && vtx_attr.g0.NormalIndex3)
            idx_count = 3;
          off += idx_size * idx_count;
        }
      }

      // Read colors
      for (u32 c = 0; c < vtx_desc.low.Color.Size(); c++)
      {
        if (vtx_desc.low.Color[c] == VertexComponentFormat::Direct)
        {
          ColorFormat cfmt = vtx_attr.GetColorFormat(c);
          if (cfmt == ColorFormat::RGBA8888 && c == 0)
          {
            vi.cr = vertex_data[off]; vi.cg = vertex_data[off+1];
            vi.cb = vertex_data[off+2]; vi.ca = vertex_data[off+3];
            vi.has_color = true;
            off += 4;
          }
          else
          {
            static constexpr u32 csizes[] = {2, 3, 4, 2, 3, 4};
            if (static_cast<u32>(cfmt) <= 5) off += csizes[static_cast<u32>(cfmt)];
          }
        }
        else if (vtx_desc.low.Color[c] == VertexComponentFormat::Index8)
          off += 1;
        else if (vtx_desc.low.Color[c] == VertexComponentFormat::Index16)
          off += 2;
      }

      // Read all tex coord sets (UV0, UV1, ...)
      for (u32 t = 0; t < vtx_desc.high.TexCoord.Size(); t++)
      {
        if (vtx_desc.high.TexCoord[t] == VertexComponentFormat::Direct)
        {
          u32 tcount = (vtx_attr.GetTexElements(t) == TexComponentCount::ST) ? 2 : 1;
          ComponentFormat tfmt = vtx_attr.GetTexFormat(t);
          if (t < 8 && vi.has_pos)
          {
            if (tfmt == ComponentFormat::Float)
            {
              vi.uvs[t][0] = std::bit_cast<float>(Common::swap32(&vertex_data[off]));
              if (tcount >= 2) vi.uvs[t][1] = std::bit_cast<float>(Common::swap32(&vertex_data[off+4]));
              vi.has_uv_set[t] = true;
            }
            else if (tfmt == ComponentFormat::UShort)
            {
              u32 shift = vtx_attr.GetTexFrac(t);
              u16 raw_u = Common::swap16(&vertex_data[off]);
              u16 raw_v = (tcount >= 2) ? Common::swap16(&vertex_data[off+2]) : 0;
              vi.uvs[t][0] = static_cast<float>(raw_u) / static_cast<float>(1 << shift);
              vi.uvs[t][1] = static_cast<float>(raw_v) / static_cast<float>(1 << shift);
              vi.has_uv_set[t] = true;
            }
          }
          off += tcount * GetElementSize(tfmt);
        }
        else if (vtx_desc.high.TexCoord[t] != VertexComponentFormat::NotPresent)
        {
          off += (vtx_desc.high.TexCoord[t] == VertexComponentFormat::Index8) ? 1 : 2;
        }
      }

      pg.vertices.push_back(vi);
    }
    m_primitives.push_back(pg);
  }

  OPCODE_CALLBACK(void OnCP(const u8 command, const u32 value)) {}
  OPCODE_CALLBACK(void OnIndexedLoad(const CPArray array, const u32 index, const u16 address,
                                     const u8 size)) {}
  OPCODE_CALLBACK(void OnDisplayList(const u32 address, const u32 size)) {}
  OPCODE_CALLBACK(void OnNop(const u32 count)) {}
  OPCODE_CALLBACK(void OnUnknown(u8 opcode, const u8* data)) {}
  OPCODE_CALLBACK(void OnCommand(const u8* data, u32 size)) {}
  OPCODE_CALLBACK(CPState& GetCPState()) { return m_cpmem; }

  std::string GenerateSummary() const
  {
    std::ostringstream ss;
    ss << "  ╔══════════════════════════════════════════════════════════════╗\n";
    ss << "  ║                    OBJECT SUMMARY                          ║\n";
    ss << "  ╠══════════════════════════════════════════════════════════════╣\n";

    // Position matrix (NW4R pane position)
    if (m_has_pos_matrix)
    {
      ss << fmt::format("  ║ Position: tx={:.1f}  ty={:.1f}  tz={:.1f}\n", m_pos_tx, m_pos_ty, m_pos_tz);
      ss << fmt::format("  ║ Scale:    sx={:.4f}  sy={:.4f}\n", m_pos_sx, m_pos_sy);
    }

    // TEV stages
    if (m_genmode_set)
    {
      ss << fmt::format("  ║ TEV Stages: {}\n", m_num_tev_stages);
    }

    // Color channel source
    {
      const char* color_src = (m_chan0_color_src == 1) ? "Vertex" : (m_chan0_color_src == 0 ? "Register" : "Unknown");
      const char* alpha_src = (m_chan0_alpha_src == 1) ? "Vertex" : (m_chan0_alpha_src == 0 ? "Register" : "Unknown");
      ss << fmt::format("  ║ Chan0 Color: {}  Alpha: {}\n", color_src, alpha_src);
    }

    // Textures (with wrap modes)
    for (int i = 0; i < 8; i++)
    {
      if (m_tex_set[i])
      {
        static const char* fmtNames[] = {"I4","I8","IA4","IA8","RGB565","RGB5A3","RGBA8","?",
                                         "CI4","CI8","CI14x2","?","?","?","CMPR","?"};
        static const char* wrapNames[] = {"Clamp","Repeat","Mirror","??"};
        const char* fn = (m_tex_fmt[i] < 16) ? fmtNames[m_tex_fmt[i]] : "?";
        std::string tex_name;
        if (g_texture_cache)
          tex_name = g_texture_cache->GetTextureNameByAddress(m_tex_addr[i]);
        if (!tex_name.empty())
        {
          ss << fmt::format("  ║ Tex{}: {}x{}  fmt={}({})  addr=0x{:08X}  name={}\n",
                            i, m_tex_width[i], m_tex_height[i], fn, m_tex_fmt[i], m_tex_addr[i],
                            tex_name);
        }
        else
        {
          ss << fmt::format("  ║ Tex{}: {}x{}  fmt={}({})  addr=0x{:08X}\n",
                            i, m_tex_width[i], m_tex_height[i], fn, m_tex_fmt[i], m_tex_addr[i]);
        }
        if (m_tex_wrap_set[i])
        {
          const char* ws = (m_tex_wrap_s[i] < 3) ? wrapNames[m_tex_wrap_s[i]] : wrapNames[3];
          const char* wt = (m_tex_wrap_t[i] < 3) ? wrapNames[m_tex_wrap_t[i]] : wrapNames[3];
          ss << fmt::format("  ║   Wrap: S={} ({})  T={} ({})\n",
                            ws, m_tex_wrap_s[i], wt, m_tex_wrap_t[i]);
        }
      }
    }

    // TexCoordGen info
    if (m_num_texgens_set)
    {
      ss << fmt::format("  ║ TexGens: {}\n", m_num_texgens);
      static const char* srcNames[] = {"Geom","Normal","Colors","BinT","BinB",
                                       "Tex0","Tex1","Tex2","Tex3","Tex4","Tex5","Tex6","Tex7"};
      static const char* typeNames[] = {"Regular","EmbossMap","Color0","Color1"};
      for (u32 i = 0; i < m_num_texgens && i < 8; i++)
      {
        if (m_texmtxinfo_set[i])
        {
          TexMtxInfo tmi; tmi.hex = m_texmtxinfo[i];
          u32 src = static_cast<u32>(tmi.sourcerow.Value());
          u32 type = static_cast<u32>(tmi.texgentype.Value());
          const char* srcN = (src < 13) ? srcNames[src] : "?";
          const char* typeN = (type < 4) ? typeNames[type] : "?";
          ss << fmt::format("  ║   TexGen[{}]: src={} ({})  type={}  proj={}\n",
                            i, srcN, src, typeN,
                            tmi.projection == TexSize::ST ? "ST" : "STQ");
        }
      }
    }

    // Texture matrices (non-identity only)
    for (int i = 0; i < 8; i++)
    {
      if (!m_texmtx_set[i]) continue;
      // Check if identity (row0=[1,0,0,0] row1=[0,1,0,0])
      bool is_identity = (m_texmtx[i][0] == 1.0f && m_texmtx[i][1] == 0.0f &&
                          m_texmtx[i][2] == 0.0f && m_texmtx[i][3] == 0.0f &&
                          m_texmtx[i][4] == 0.0f && m_texmtx[i][5] == 1.0f &&
                          m_texmtx[i][6] == 0.0f && m_texmtx[i][7] == 0.0f);
      if (!is_identity)
      {
        ss << fmt::format("  ║   TexMtx[{}]: [{:.4f} {:.4f} {:.4f} {:.4f}]\n",
                          i, m_texmtx[i][0], m_texmtx[i][1], m_texmtx[i][2], m_texmtx[i][3]);
        ss << fmt::format("  ║              [{:.4f} {:.4f} {:.4f} {:.4f}]\n",
                          m_texmtx[i][4], m_texmtx[i][5], m_texmtx[i][6], m_texmtx[i][7]);
      }
    }

    // ── TEV Color Registers (all 4, unified color + konst banks) ──
    // GX has 4 TEV color registers (c0-c3). NW4R typically uses:
    //   c0 = set via konst bank (often white=0xFFFFFFFF, sometimes backColor)
    //   c1 = foreColor from BRLYT material
    //   c2 = backColor from BRLYT material
    //   c3 = usually white (unused)
    // The Type bit in BP register writes determines which bank:
    //   Type=0 (Color): TEV output destination bank
    //   Type=1 (Constant/Konst): TEV constant input bank
    // Both banks feed the same register from the TEV stage's perspective.
    ss << "  ║ ── TEV Registers ──\n";

    // Helper to decode 11-bit RA/BG to 8-bit RGBA
    auto decode_tev_rgba = [](u32 ra, u32 bg, int& r8, int& g8, int& b8, int& a8) {
      int r11 = ra & 0x7FF;
      int a11 = (ra >> 12) & 0x7FF;
      int b11 = bg & 0x7FF;
      int g11 = (bg >> 12) & 0x7FF;
      r8 = std::clamp(r11, 0, 255);
      g8 = std::clamp(g11, 0, 255);
      b8 = std::clamp(b11, 0, 255);
      a8 = std::clamp(a11, 0, 255);
    };

    // Store decoded RGBA for use in effective output computation later
    int reg_r[4] = {}, reg_g[4] = {}, reg_b[4] = {}, reg_a[4] = {};
    bool reg_known[4] = {};

    for (int i = 0; i < 4; i++)
    {
      bool has_color = m_tev_color_set[i];
      bool has_konst = m_tev_konst_set[i];

      if (has_color || has_konst)
      {
        // NW4R sets material colors (foreColor/backColor) via the Color bank (Type=0).
        // The Konst bank (Type=1) is typically a global reset to white for all registers.
        // For registers 1-3: prefer Color bank (actual material values)
        // For register 0: usually only set via Konst bank (c0 is rarely written as Color)
        u32 ra, bg;
        const char* bank_label;
        if (has_color)
        {
          ra = m_tev_color_ra[i]; bg = m_tev_color_bg[i];
          bank_label = "color";
        }
        else
        {
          ra = m_tev_konst_ra[i]; bg = m_tev_konst_bg[i];
          bank_label = "konst";
        }

        int r8, g8, b8, a8;
        decode_tev_rgba(ra, bg, r8, g8, b8, a8);
        reg_r[i] = r8; reg_g[i] = g8; reg_b[i] = b8; reg_a[i] = a8;
        reg_known[i] = true;

        // NW4R mapping hints
        const char* nw4r_hint = "";
        if (i == 0) nw4r_hint = "  (lerp endpoint 'a')";
        else if (i == 1) nw4r_hint = "  ← NW4R foreColor";
        else if (i == 2) nw4r_hint = "  ← NW4R backColor";

        ss << fmt::format("  ║   Reg{} (c{}): RGBA({},{},{},{})  [{}]{}",
                          i, i, r8, g8, b8, a8, bank_label, nw4r_hint);

        // If BOTH banks were written with different values, show the alternative bank
        if (has_color && has_konst)
        {
          // Show whichever bank was NOT selected as primary
          u32 alt_ra, alt_bg;
          const char* alt_label;
          if (has_color)  // color was primary
          {
            alt_ra = m_tev_konst_ra[i]; alt_bg = m_tev_konst_bg[i];
            alt_label = "konst";
          }
          else  // konst was primary
          {
            alt_ra = m_tev_color_ra[i]; alt_bg = m_tev_color_bg[i];
            alt_label = "color";
          }
          int cr, cg, cb, ca;
          decode_tev_rgba(alt_ra, alt_bg, cr, cg, cb, ca);
          if (cr != r8 || cg != g8 || cb != b8 || ca != a8)
          {
            ss << fmt::format("\n  ║          also {} bank: RGBA({},{},{},{})", alt_label, cr, cg, cb, ca);
          }
        }
        ss << "\n";
      }
    }

    // ── NW4R Material Mapping Summary ──
    if (reg_known[1] || reg_known[2])
    {
      ss << "  ║ ── NW4R Material Mapping ──\n";
      if (reg_known[1])
        ss << fmt::format("  ║   foreColor = RGBA({},{},{},{})\n", reg_r[1], reg_g[1], reg_b[1], reg_a[1]);
      if (reg_known[2])
        ss << fmt::format("  ║   backColor = RGBA({},{},{},{})\n", reg_r[2], reg_g[2], reg_b[2], reg_a[2]);
    }

    // TEV stage formulas (with destination)
    static constexpr const char* cnames[] = {
        "prev.rgb","prev.aaa","c0.rgb","c0.aaa","c1.rgb","c1.aaa","c2.rgb","c2.aaa",
        "tex.rgb","tex.aaa","ras.rgb","ras.aaa","1",".5","konst.rgb","0"};
    static constexpr const char* anames[] = {
        "prev","c0","c1","c2","tex","ras","konst","0"};
    static constexpr const char* dest_names[] = {"prev","c0","c1","c2"};

    auto cn = [](u32 v) -> const char* { return (v < 16) ? cnames[v] : "?"; };
    auto an = [](u32 v) -> const char* { return (v < 8) ? anames[v] : "?"; };
    auto dn = [](u32 v) -> const char* { return (v < 4) ? dest_names[v] : "?"; };

    for (u32 s = 0; s < m_num_tev_stages && s < 16; s++)
    {
      if (m_tev_env_set[s])
      {
        TevStageCombiner::ColorCombiner cc; cc.hex = m_tev_color_env[s];
        TevStageCombiner::AlphaCombiner ac; ac.hex = m_tev_alpha_env[s];

        u32 ca = static_cast<u32>(cc.a.Value());
        u32 cb = static_cast<u32>(cc.b.Value());
        u32 ccv = static_cast<u32>(cc.c.Value());
        u32 cd = static_cast<u32>(cc.d.Value());
        u32 c_dest = static_cast<u32>(cc.dest.Value());
        u32 aa = static_cast<u32>(ac.a.Value());
        u32 ab = static_cast<u32>(ac.b.Value());
        u32 acv = static_cast<u32>(ac.c.Value());
        u32 ad = static_cast<u32>(ac.d.Value());
        u32 a_dest = static_cast<u32>(ac.dest.Value());

        ss << fmt::format("  ║ Stage{} Color: d={} + lerp(a={}, b={}, c={}) → {}\n",
                          s, cn(cd), cn(ca), cn(cb), cn(ccv), dn(c_dest));
        ss << fmt::format("  ║ Stage{} Alpha: d={} + lerp(a={}, b={}, c={}) → {}\n",
                          s, an(ad), an(aa), an(ab), an(acv), dn(a_dest));

        // Show TREF info for this stage
        if (m_tref_set)
        {
          int tref_idx = s / 2;
          int tref_sub = s % 2;
          if (tref_idx < 8)
          {
            TwoTevStageOrders tref; tref.hex = m_tref[tref_idx];
            u32 texmap = tref.getTexMap(tref_sub);
            u32 texcoord = tref.getTexCoord(tref_sub);
            bool enable = tref.getEnable(tref_sub);
            RasColorChan raschan = tref.getColorChan(tref_sub);
            ss << fmt::format("  ║ Stage{} TexMap={} TexCoord={} Enable={} RasColor={}\n",
                              s, texmap, texcoord, enable ? "Y" : "N", fmt::to_string(raschan));
          }
        }
        // Show konst color selection for this stage (from KSEL)
        {
          int ksel_idx = s >> 1;
          if (m_ksel_set[ksel_idx])
          {
            TevKSel ksel; ksel.hex = m_ksel[ksel_idx];
            KonstSel kcsel = (s & 1) ? ksel.kcsel_odd.Value() : ksel.kcsel_even.Value();
            KonstSel kasel = (s & 1) ? ksel.kasel_odd.Value() : ksel.kasel_even.Value();
            bool uses_konst = (ccv == 14 || ca == 14 || cb == 14 || cd == 14 ||
                              acv == 6 || aa == 6 || ab == 6 || ad == 6);
            if (uses_konst)
            {
              ss << fmt::format("  ║ Stage{} Konst: color={} alpha={}\n",
                                s, kcsel, kasel);
            }
          }
        }
      }
    }

    // ── Effective TEV Pipeline (human-readable interpretation) ──
    if (m_num_tev_stages > 0 && m_num_tev_stages <= 16)
    {
      ss << "  ║ ── Effective TEV Pipeline ──\n";

      // Helper to describe a register value
      auto reg_desc = [&](int idx) -> std::string {
        if (!reg_known[idx]) return fmt::format("c{}=?", idx);
        return fmt::format("({},{},{},{})", reg_r[idx], reg_g[idx], reg_b[idx], reg_a[idx]);
      };

      for (u32 s = 0; s < m_num_tev_stages && s < 16; s++)
      {
        if (!m_tev_env_set[s]) continue;

        TevStageCombiner::ColorCombiner cc; cc.hex = m_tev_color_env[s];
        TevStageCombiner::AlphaCombiner ac; ac.hex = m_tev_alpha_env[s];

        u32 ca = static_cast<u32>(cc.a.Value());
        u32 cb = static_cast<u32>(cc.b.Value());
        u32 ccv = static_cast<u32>(cc.c.Value());
        u32 cd = static_cast<u32>(cc.d.Value());

        // Identify common NW4R TEV patterns
        // Pattern 1: lerp(c0, c1, tex) — standard foreColor/backColor lerp
        if (cd == 15 /*Zero*/ && ca == 2 /*c0.rgb*/ && cb == 4 /*c1.rgb*/ && ccv == 8 /*tex.rgb*/)
        {
          if (reg_known[0] && reg_known[1])
          {
            bool same_rgb = (reg_r[0] == reg_r[1] && reg_g[0] == reg_g[1] && reg_b[0] == reg_b[1]);
            if (reg_r[0] == 255 && reg_g[0] == 255 && reg_b[0] == 255 &&
                reg_r[1] == 0 && reg_g[1] == 0 && reg_b[1] == 0)
            {
              ss << fmt::format("  ║   Stage{}: color = (1 - tex.rgb)  [white-to-black lerp → inverted texture]\n", s);
            }
            else if (reg_r[0] == 0 && reg_g[0] == 0 && reg_b[0] == 0 &&
                     reg_r[1] == 255 && reg_g[1] == 255 && reg_b[1] == 255)
            {
              ss << fmt::format("  ║   Stage{}: color = tex.rgb  [black-to-white lerp → texture passthrough]\n", s);
            }
            else if (same_rgb)
            {
              ss << fmt::format("  ║   Stage{}: color = ({},{},{})  [same RGB in c0 & c1 → flat color]\n",
                                s, reg_r[0], reg_g[0], reg_b[0]);
            }
            else
            {
              ss << fmt::format("  ║   Stage{}: color = lerp({}, {}, tex)  [c0*(1-tex) + c1*tex]\n",
                                s, reg_desc(0), reg_desc(1));
            }
          }
          else
          {
            ss << fmt::format("  ║   Stage{}: color = lerp(c0, c1, tex)\n", s);
          }

          // Alpha
          u32 aa = static_cast<u32>(ac.a.Value());
          u32 ab_v = static_cast<u32>(ac.b.Value());
          u32 acv_v = static_cast<u32>(ac.c.Value());
          u32 ad_v = static_cast<u32>(ac.d.Value());
          if (ad_v == 7 /*Zero*/ && aa == 1 /*c0*/ && ab_v == 2 /*c1*/ && acv_v == 4 /*tex*/)
          {
            if (reg_known[0] && reg_known[1])
            {
              if (reg_a[0] == reg_a[1])
                ss << fmt::format("  ║   Stage{}: alpha = {}  [c0.a == c1.a → constant]\n", s, reg_a[0]);
              else if (reg_a[0] == 0)
                ss << fmt::format("  ║   Stage{}: alpha = {} * tex.a  [c0.a=0, scales by c1.a]\n", s, reg_a[1]);
              else
                ss << fmt::format("  ║   Stage{}: alpha = lerp({}, {}, tex.a)\n", s, reg_a[0], reg_a[1]);
            }
          }
          else if (ad_v == 2 /*c1*/ && aa == 7 /*Zero*/ && ab_v == 7 /*Zero*/ && acv_v == 7 /*Zero*/)
          {
            if (reg_known[1])
              ss << fmt::format("  ║   Stage{}: alpha = {}  [passthrough c1.a = foreColor.a]\n", s, reg_a[1]);
          }
          else
          {
            ss << fmt::format("  ║   Stage{}: alpha = d={} + lerp({}, {}, {})\n",
                              s, an(ad_v), an(aa), an(ab_v), an(acv_v));
          }
        }
        // Pattern 2: prev * ras (vertex color modulation)
        else if (cd == 15 /*Zero*/ && ca == 15 /*Zero*/ && cb == 0 /*prev.rgb*/ && ccv == 10 /*ras.rgb*/)
        {
          ss << fmt::format("  ║   Stage{}: color = prev * vtxColor  [vertex color modulation]\n", s);

          u32 aa = static_cast<u32>(ac.a.Value());
          u32 ab_v = static_cast<u32>(ac.b.Value());
          u32 acv_v = static_cast<u32>(ac.c.Value());
          if (aa == 7 /*Zero*/ && ab_v == 0 /*prev*/ && acv_v == 5 /*ras*/)
            ss << fmt::format("  ║   Stage{}: alpha = prev.a * vtxColor.a  [if vtxColor.a=0 → transparent!]\n", s);
          else
            ss << fmt::format("  ║   Stage{}: alpha = d={} + lerp({}, {}, {})\n",
                              s, an(static_cast<u32>(ac.d.Value())), an(aa), an(ab_v), an(acv_v));
        }
        // Pattern 3: d=prev + b*c (additive blend with prev)
        else if (cd == 0 /*prev.rgb*/ && ca == 15 /*Zero*/)
        {
          ss << fmt::format("  ║   Stage{}: color = prev + {}*{}  [additive blend]\n",
                            s, cn(cb), cn(ccv));
        }
        // Pattern 4: d=prev, no lerp (passthrough)
        else if (cd == 0 /*prev.rgb*/ && ca == 15 && cb == 15 && ccv == 15)
        {
          ss << fmt::format("  ║   Stage{}: color = prev  [passthrough]\n", s);
        }
        else
        {
          ss << fmt::format("  ║   Stage{}: [custom formula — see raw stage config above]\n", s);
        }
      }

      // Final note about vertex colors
      if (!m_primitives.empty() && !m_primitives[0].vertices.empty() && m_primitives[0].vertices[0].has_color)
      {
        bool all_same_alpha = true;
        u8 first_alpha = m_primitives[0].vertices[0].ca;
        for (const auto& pg : m_primitives)
        {
          for (const auto& v : pg.vertices)
          {
            if (v.has_color && v.ca != first_alpha) { all_same_alpha = false; break; }
          }
        }
        if (all_same_alpha && first_alpha == 0)
          ss << "  ║   ⚠ All vertex alpha = 0 → object is fully TRANSPARENT\n";
        else if (all_same_alpha && first_alpha == 255)
          ss << "  ║   ✓ All vertex alpha = 255 → vertex alpha has no effect\n";
      }
    }

    // Blend mode (proper decode using BlendMode struct)
    if (m_blend_set)
    {
      BlendMode bm; bm.hex = m_blend_val;
      if (bm.blend_enable)
      {
        ss << fmt::format("  ║ Blend: {} * src {} {} * dst\n",
                          bm.src_factor, bm.subtract ? "-" : "+", bm.dst_factor);
      }
      else
      {
        ss << "  ║ Blend: OFF\n";
      }
    }

    // Scissor rectangle
    if (m_scissor_set)
    {
      ScissorPos tl; tl.hex = m_scissor_tl;
      ScissorPos br; br.hex = m_scissor_br;
      int x0 = static_cast<int>(tl.x.Value()) - 342;
      int y0 = static_cast<int>(tl.y.Value()) - 342;
      int x1 = static_cast<int>(br.x.Value()) - 341;
      int y1 = static_cast<int>(br.y.Value()) - 341;
      ss << fmt::format("  ║ Scissor: ({},{}) - ({},{})  clip={}x{}\n",
                        x0, y0, x1, y1, x1-x0, y1-y0);
    }

    // SU coord scale per texcoord unit
    for (int i = 0; i < 8; i++)
    {
      if (!m_su_set[i]) continue;
      u32 s_scale = (m_su_ssize[i] & 0x3FF) + 1;  // 10-bit scale value + 1
      u32 t_scale = (m_su_tsize[i] & 0x3FF) + 1;
      bool s_bias = (m_su_ssize[i] >> 16) & 1;
      bool t_bias = (m_su_tsize[i] >> 16) & 1;
      ss << fmt::format("  ║ SU[{}]: S={}{}  T={}{}\n",
                        i, s_scale, s_bias ? " (bias)" : "",
                        t_scale, t_bias ? " (bias)" : "");
    }

    // Vertex data
    if (m_prim_count > 0)
    {
      ss << fmt::format("  ║ Primitives: {} draw(s)\n", m_prim_count);

      size_t vi = 0;
      float minx = 1e9f, miny = 1e9f, maxx = -1e9f, maxy = -1e9f;
      for (const auto& pg : m_primitives)
      {
        for (const auto& v : pg.vertices)
        {
          if (vi < 8)
          {
            ss << "  ║   V" << vi << ": ";
            if (v.has_pos) ss << fmt::format("pos=({:.2f},{:.2f},{:.2f}) ", v.px, v.py, v.pz);
            if (v.has_color) ss << fmt::format("rgba=({},{},{},{}) ", v.cr, v.cg, v.cb, v.ca);
            for (int t = 0; t < 8; t++)
            {
              if (v.has_uv_set[t])
                ss << fmt::format("uv{}=({:.4f},{:.4f}) ", t, v.uvs[t][0], v.uvs[t][1]);
            }
            ss << "\n";
          }
          vi++;

          if (v.has_pos)
          {
            if (v.px < minx) minx = v.px;
            if (v.py < miny) miny = v.py;
            if (v.px > maxx) maxx = v.px;
            if (v.py > maxy) maxy = v.py;
          }
        }
      }
      if (vi > 8)
        ss << fmt::format("  ║   ... and {} more vertices\n", vi - 8);

      if (minx < 1e8f)
      {
        ss << fmt::format("  ║ BBox: ({:.1f},{:.1f}) - ({:.1f},{:.1f})  size={:.1f}x{:.1f}\n",
                          minx, miny, maxx, maxy, maxx-minx, maxy-miny);
      }
    }

    ss << "  ╚══════════════════════════════════════════════════════════════╝\n";
    return ss.str();
  }

  struct VertexInfo
  {
    float px = 0, py = 0, pz = 0;
    u32 pos_idx = 0;
    u8 cr = 0, cg = 0, cb = 0, ca = 0;
    float uvs[8][2] = {};  // up to 8 UV sets
    bool has_pos = false, has_color = false;
    bool has_uv_set[8] = {};
  };

  struct PrimitiveGroup
  {
    OpcodeDecoder::Primitive type;
    std::vector<VertexInfo> vertices;
  };

  CPState m_cpmem;
  bool m_has_pos_matrix = false;
  float m_pos_tx = 0, m_pos_ty = 0, m_pos_tz = 0;
  float m_pos_sx = 1, m_pos_sy = 1;
  float m_pos_matrices[268] = {};
  bool m_genmode_set = false;
  u32 m_num_tev_stages = 0;
  bool m_tex_set[8] = {};
  u32 m_tex_width[8] = {}, m_tex_height[8] = {}, m_tex_fmt[8] = {}, m_tex_addr[8] = {};
  // Texture wrap modes per unit
  bool m_tex_wrap_set[8] = {};
  u32 m_tex_wrap_s[8] = {}, m_tex_wrap_t[8] = {};
  // TexCoordGen info per tex gen
  u32 m_num_texgens = 0;
  bool m_num_texgens_set = false;
  bool m_texmtxinfo_set[8] = {};
  u32 m_texmtxinfo[8] = {};
  // Texture matrices (2x4 = 8 floats each)
  bool m_texmtx_set[8] = {};
  float m_texmtx[8][8] = {};
  u32 m_tev_color_ra[4] = {}, m_tev_color_bg[4] = {};
  bool m_tev_color_set[4] = {};
  u32 m_tev_konst_ra[4] = {}, m_tev_konst_bg[4] = {};
  bool m_tev_konst_set[4] = {};
  u32 m_tev_color_env[16] = {}, m_tev_alpha_env[16] = {};
  bool m_tev_env_set[16] = {};
  u32 m_tref[8] = {};
  bool m_tref_set = false;
  bool m_blend_set = false;
  u32 m_blend_val = 0;
  // Scissor rectangle
  bool m_scissor_set = false;
  u32 m_scissor_tl = 0, m_scissor_br = 0;
  // Konst color selection
  u32 m_ksel[8] = {};
  bool m_ksel_set[8] = {};
  // SU coord scale per texcoord unit
  u32 m_su_ssize[8] = {}, m_su_tsize[8] = {};
  bool m_su_set[8] = {};
  u32 m_prim_count = 0;
  std::vector<PrimitiveGroup> m_primitives;
  int m_chan0_color_src = -1, m_chan0_alpha_src = -1;
  // GX Viewport (from XF 0x101A)
  bool m_vp_set = false;
  float m_vp_wd = 304.0f, m_vp_ht = -228.0f;
  float m_vp_x_orig = 304.0f, m_vp_y_orig = 228.0f;
  // GX Projection (from XF 0x1020)
  bool m_proj_set = false;
  u32 m_proj_type = 1;  // 0=perspective, 1=orthographic
  float m_proj_params[6] = {};
};
}  // namespace

void FIFOAnalyzer::ExportAll()
{
  if (!m_fifo_player.IsPlaying())
  {
    QMessageBox::warning(this, tr("Export"), tr("No FIFO recording loaded."));
    return;
  }

  const QString filename = QFileDialog::getSaveFileName(
      this, tr("Export FIFO Analysis"), QString(), tr("Text Files (*.txt);;All Files (*)"));

  if (filename.isEmpty())
    return;

  std::ofstream out(filename.toStdString());
  if (!out.is_open())
  {
    QMessageBox::critical(this, tr("Export"), tr("Failed to open file for writing."));
    return;
  }

  // Create a textures subfolder alongside the text file
  const std::filesystem::path txt_path(filename.toStdString());
  const std::filesystem::path tex_folder = txt_path.parent_path() / (txt_path.stem().string() + "_textures");
  std::filesystem::create_directories(tex_folder);

  // Track exported textures to avoid duplicates
  std::set<u32> exported_tex_addrs;
  u32 tex_export_count = 0;

  const auto* const file = m_fifo_player.GetFile();
  const u32 frame_count = file->GetFrameCount();

  out << "=== FIFO Analysis Export (Enhanced for NW4R Layout Debugging) ===" << std::endl;
  out << "Total Frames: " << frame_count << std::endl;
  out << "Textures exported to: " << tex_folder.filename().string() << "/" << std::endl;
  out << std::endl;

  for (u32 frame = 0; frame < frame_count; frame++)
  {
    const AnalyzedFrameInfo& frame_info = m_fifo_player.GetAnalyzedFrameInfo(frame);
    const auto& fifo_frame = file->GetFrame(frame);

    out << "==============================" << std::endl;
    out << "FRAME " << frame << std::endl;
    out << "==============================" << std::endl;

    u32 part_start = 0;
    u32 object_idx = 0;

    for (u32 part_nr = 0; part_nr < frame_info.parts.size(); part_nr++)
    {
      const auto& part = frame_info.parts[part_nr];

      bool is_boundary = (part.m_type == FramePartType::PrimitiveData ||
                          part.m_type == FramePartType::EFBCopy);

      if (!is_boundary)
        continue;

      const u32 start_part = part_start;
      const u32 end_part = part_nr;
      part_start = part_nr + 1;

      const u32 obj_start = frame_info.parts[start_part].m_start;
      const u32 obj_end = frame_info.parts[end_part].m_end;
      const u32 obj_size = obj_end - obj_start;

      if (part.m_type == FramePartType::PrimitiveData)
        out << std::endl << "--- Object " << object_idx << " ---" << std::endl;
      else
        out << std::endl << "--- EFB Copy ---" << std::endl;

      object_idx++;

      // First pass: accumulate state for summary
      auto summary_cb = SummaryCallback(frame_info.parts[end_part].m_cpmem);
      summary_cb.Reset();
      {
        u32 soff = 0;
        while (soff < obj_size)
        {
          soff += OpcodeDecoder::RunCommand(
              &fifo_frame.fifoData[obj_start + soff],
              obj_size - soff, summary_cb);
        }
      }

      // Write summary block
      out << summary_cb.GenerateSummary();

      // Export textures for this object (CPU-side decode from FIFO memory data)
      for (int i = 0; i < 8; i++)
      {
        if (!summary_cb.m_tex_set[i])
          continue;
        if (exported_tex_addrs.count(summary_cb.m_tex_addr[i]))
          continue;

        const u32 tex_addr = summary_cb.m_tex_addr[i];
        const u32 tex_w = summary_cb.m_tex_width[i];
        const u32 tex_h = summary_cb.m_tex_height[i];
        const u32 tex_fmt_raw = summary_cb.m_tex_fmt[i];

        // Validate dimensions and format
        if (tex_w == 0 || tex_h == 0 || tex_w > 2048 || tex_h > 2048)
          continue;
        if (tex_fmt_raw > 14)
          continue;

        const TextureFormat tex_fmt = static_cast<TextureFormat>(tex_fmt_raw);

        // Skip color-indexed formats (CI4, CI8, CI14x2) — need palette data we don't have
        if (IsColorIndexed(tex_fmt))
          continue;

        // Compute aligned dimensions and texture data size
        const u32 block_w = TexDecoder_GetBlockWidthInTexels(tex_fmt);
        const u32 block_h = TexDecoder_GetBlockHeightInTexels(tex_fmt);
        if (block_w == 0 || block_h == 0)
          continue;

        const u32 expanded_w = Common::AlignUp(tex_w, block_w);
        const u32 expanded_h = Common::AlignUp(tex_h, block_h);
        const u32 tex_data_size = TexDecoder_GetTextureSizeInBytes(expanded_w, expanded_h, tex_fmt);
        if (tex_data_size == 0)
          continue;

        // Find the texture data in the FIFO recording's memory updates
        const u8* tex_data = nullptr;
        for (const auto& mem_update : fifo_frame.memoryUpdates)
        {
          if (mem_update.type != MemoryUpdate::Type::TextureMap)
            continue;
          if (mem_update.data.empty())
            continue;
          if (tex_addr < mem_update.address)
            continue;

          const u32 offset_in_update = tex_addr - mem_update.address;
          if (offset_in_update + tex_data_size > static_cast<u32>(mem_update.data.size()))
            continue;

          tex_data = &mem_update.data[offset_in_update];
          break;
        }

        if (!tex_data)
          continue;

        // Decode the GX texture to RGBA8 on the CPU
        const u32 stride = expanded_w * 4;
        std::vector<u8> decoded(stride * expanded_h);
        TexDecoder_Decode(decoded.data(), tex_data, expanded_w, expanded_h, tex_fmt, nullptr,
                          TLUTFormat::IA8);

        // Build texture name and save as PNG
        std::string tex_name;
        if (g_texture_cache)
          tex_name = g_texture_cache->GetTextureNameByAddress(tex_addr);
        if (tex_name.empty())
          tex_name = fmt::format("tex_0x{:08X}_{}x{}", tex_addr, tex_w, tex_h);

        const std::filesystem::path tex_path = tex_folder / (tex_name + ".png");
        Common::SavePNG(tex_path.string(), decoded.data(), Common::ImageByteFormat::RGBA,
                        tex_w, tex_h, stride);
        exported_tex_addrs.insert(tex_addr);
        tex_export_count++;
      }

      // Second pass: detailed command listing (existing behavior)
      auto detail_cb = DetailCallback(frame_info.parts[end_part].m_cpmem);
      auto desc_cb = DescriptionCallback(frame_info.parts[end_part].m_cpmem);
      u32 offset = 0;

      while (offset < obj_size)
      {
        const u32 cmd_start_off = offset;

        // Get summary text
        offset += OpcodeDecoder::RunCommand(
            &fifo_frame.fifoData[obj_start + cmd_start_off],
            obj_size - cmd_start_off, detail_cb);

        // Get description text
        OpcodeDecoder::RunCommand(
            &fifo_frame.fifoData[obj_start + cmd_start_off],
            obj_size - cmd_start_off, desc_cb);

        const u32 abs_addr = obj_start + cmd_start_off;
        out << fmt::format("{:08X}: ", abs_addr)
            << detail_cb.text.toStdString() << std::endl;

        // Write description for primitives and BP registers (most useful info)
        const std::string desc_str = desc_cb.text.toStdString();
        if (!desc_str.empty() && desc_str != "No description available")
        {
          // Indent description lines
          std::istringstream iss(desc_str);
          std::string line;
          while (std::getline(iss, line))
          {
            out << "    " << line << std::endl;
          }
        }
      }
    }
  }

  out.close();

  QMessageBox::information(this, tr("Export"),
      tr("Exported FIFO analysis to:\n%1\n\nExported %2 textures to:\n%3")
          .arg(filename)
          .arg(tex_export_count)
          .arg(QString::fromStdString(tex_folder.string())));
}

void FIFOAnalyzer::ExportScene()
{
  if (!m_fifo_player.IsPlaying())
  {
    QMessageBox::warning(this, tr("Export Scene"), tr("No FIFO recording loaded."));
    return;
  }

  const QString dir = QFileDialog::getExistingDirectory(
      this, tr("Select Export Directory for Scene"));
  if (dir.isEmpty())
    return;

  ExportSceneTo(dir);
}

void FIFOAnalyzer::ExportSceneTo(const QString& dir, bool headless)
{
  const std::filesystem::path export_dir(dir.toStdString());
  const std::filesystem::path tex_folder = export_dir / "textures";
  std::filesystem::create_directories(tex_folder);

  // Track exported textures to avoid duplicates
  std::set<u32> exported_tex_addrs;
  // Map tex_addr -> exported filename for scene.json references
  std::map<u32, std::string> tex_addr_to_filename;
  u32 tex_export_count = 0;

  const auto* const file = m_fifo_player.GetFile();
  const u32 frame_count = file->GetFrameCount();
  u32 total_objects = 0;

  // We'll build the JSON manually (no JSON library dependency)
  std::ostringstream json;
  json << "{\n";
  json << "  \"exportVersion\": 1,\n";

  // HTML will be written after JSON is complete (we embed the JSON data inline)
  std::ostringstream html;
  json << "  \"frameCount\": " << frame_count << ",\n";
  json << "  \"frames\": [\n";

  for (u32 frame = 0; frame < frame_count; frame++)
  {
    const AnalyzedFrameInfo& frame_info = m_fifo_player.GetAnalyzedFrameInfo(frame);
    const auto& fifo_frame = file->GetFrame(frame);

    if (frame > 0) json << ",\n";
    json << "    {\n";
    json << "      \"frameIndex\": " << frame << ",\n";
    json << "      \"objects\": [\n";

    u32 part_start = 0;
    u32 object_idx = 0;
    bool first_obj = true;

    // Reset viewport/projection tracking at frame start so state
    // commands within this frame can set them properly.
    auto summary_cb_global = SummaryCallback(frame_info.parts.empty() ?
        CPState{} : frame_info.parts[0].m_cpmem);
    summary_cb_global.ResetGlobalState();

    for (u32 part_nr = 0; part_nr < frame_info.parts.size(); part_nr++)
    {
      const auto& part = frame_info.parts[part_nr];
      bool is_boundary = (part.m_type == FramePartType::PrimitiveData ||
                          part.m_type == FramePartType::EFBCopy);
      if (!is_boundary)
        continue;

      const u32 start_part = part_start;
      const u32 end_part = part_nr;
      part_start = part_nr + 1;

      if (part.m_type != FramePartType::PrimitiveData)
      {
        object_idx++;
        continue;  // Skip EFB copies
      }

      const u32 obj_start = frame_info.parts[start_part].m_start;
      const u32 obj_end = frame_info.parts[end_part].m_end;
      const u32 obj_size = obj_end - obj_start;

      // Parse object state
      auto summary_cb = SummaryCallback(frame_info.parts[end_part].m_cpmem);
      summary_cb.Reset();
      // Inherit global viewport/projection state
      summary_cb.m_vp_set = summary_cb_global.m_vp_set;
      summary_cb.m_vp_wd = summary_cb_global.m_vp_wd;
      summary_cb.m_vp_ht = summary_cb_global.m_vp_ht;
      summary_cb.m_vp_x_orig = summary_cb_global.m_vp_x_orig;
      summary_cb.m_vp_y_orig = summary_cb_global.m_vp_y_orig;
      summary_cb.m_proj_set = summary_cb_global.m_proj_set;
      summary_cb.m_proj_type = summary_cb_global.m_proj_type;
      for (int i = 0; i < 6; i++) summary_cb.m_proj_params[i] = summary_cb_global.m_proj_params[i];
      {
        u32 soff = 0;
        while (soff < obj_size)
        {
          soff += OpcodeDecoder::RunCommand(
              &fifo_frame.fifoData[obj_start + soff],
              obj_size - soff, summary_cb);
        }
      }
      // Update global viewport/projection state if this object changed them
      if (summary_cb.m_vp_set)
      {
        summary_cb_global.m_vp_set = true;
        summary_cb_global.m_vp_wd = summary_cb.m_vp_wd;
        summary_cb_global.m_vp_ht = summary_cb.m_vp_ht;
        summary_cb_global.m_vp_x_orig = summary_cb.m_vp_x_orig;
        summary_cb_global.m_vp_y_orig = summary_cb.m_vp_y_orig;
      }
      if (summary_cb.m_proj_set)
      {
        summary_cb_global.m_proj_set = true;
        summary_cb_global.m_proj_type = summary_cb.m_proj_type;
        for (int i = 0; i < 6; i++)
          summary_cb_global.m_proj_params[i] = summary_cb.m_proj_params[i];
      }

      // Export textures for this object
      for (int i = 0; i < 8; i++)
      {
        if (!summary_cb.m_tex_set[i])
          continue;
        if (exported_tex_addrs.count(summary_cb.m_tex_addr[i]))
          continue;

        const u32 tex_addr = summary_cb.m_tex_addr[i];
        const u32 tex_w = summary_cb.m_tex_width[i];
        const u32 tex_h = summary_cb.m_tex_height[i];
        const u32 tex_fmt_raw = summary_cb.m_tex_fmt[i];

        if (tex_w == 0 || tex_h == 0 || tex_w > 2048 || tex_h > 2048)
          continue;
        if (tex_fmt_raw > 14)
          continue;

        const TextureFormat tex_fmt = static_cast<TextureFormat>(tex_fmt_raw);
        if (IsColorIndexed(tex_fmt))
          continue;

        const u32 block_w = TexDecoder_GetBlockWidthInTexels(tex_fmt);
        const u32 block_h = TexDecoder_GetBlockHeightInTexels(tex_fmt);
        if (block_w == 0 || block_h == 0)
          continue;

        const u32 expanded_w = Common::AlignUp(tex_w, block_w);
        const u32 expanded_h = Common::AlignUp(tex_h, block_h);
        const u32 tex_data_size = TexDecoder_GetTextureSizeInBytes(expanded_w, expanded_h, tex_fmt);
        if (tex_data_size == 0)
          continue;

        const u8* tex_data = nullptr;
        for (const auto& mem_update : fifo_frame.memoryUpdates)
        {
          if (mem_update.type != MemoryUpdate::Type::TextureMap)
            continue;
          if (mem_update.data.empty())
            continue;
          if (tex_addr < mem_update.address)
            continue;
          const u32 offset_in_update = tex_addr - mem_update.address;
          if (offset_in_update + tex_data_size > static_cast<u32>(mem_update.data.size()))
            continue;
          tex_data = &mem_update.data[offset_in_update];
          break;
        }

        if (!tex_data)
          continue;

        const u32 stride = expanded_w * 4;
        std::vector<u8> decoded(stride * expanded_h);
        TexDecoder_Decode(decoded.data(), tex_data, expanded_w, expanded_h, tex_fmt, nullptr,
                          TLUTFormat::IA8);

        // Build filename
        std::string tex_name;
        if (g_texture_cache)
          tex_name = g_texture_cache->GetTextureNameByAddress(tex_addr);
        if (tex_name.empty())
          tex_name = fmt::format("tex_0x{:08X}_{}x{}", tex_addr, tex_w, tex_h);

        const std::string filename = tex_name + ".png";
        const std::filesystem::path tex_path = tex_folder / filename;
        Common::SavePNG(tex_path.string(), decoded.data(), Common::ImageByteFormat::RGBA,
                        tex_w, tex_h, stride);
        exported_tex_addrs.insert(tex_addr);
        tex_addr_to_filename[tex_addr] = filename;
        tex_export_count++;
      }

      // Compute screen-space quad vertices using full GX pipeline:
      // 1. Model-view: mv = posMatrix * vertex
      // 2. Projection (ortho): clip_x = mv_x * proj[0] + proj[1]
      //                        clip_y = mv_y * proj[2] + proj[3]
      // 3. Viewport: screen_x = clip_x * vp_wd + vp_xOrig
      //              screen_y = clip_y * vp_ht + vp_yOrig

      // Collect screen-space quad vertices (up to 4) with their UVs.
      // These are the actual corners of the rendered quad after the full
      // GX pipeline.
      struct ScreenVert {
        float sx, sy;
        float uvs[8][2];
        float r, g, b, a;
      };
      std::vector<ScreenVert> triangles;

      // Helper: apply full GX pipeline to a vertex position
      // Step 1: Full 3x4 model-view matrix multiply (handles rotation/skew/mirror)
      // Step 2: Orthographic projection
      // Step 3: Viewport transform
      auto transform_vert = [&](float px, float py, float pz, u32 pos_idx) -> std::pair<float, float> {
        const float* m = &summary_cb.m_pos_matrices[(pos_idx & 0x3f) * 4];
        float mv_x = m[0]*px + m[1]*py + m[2]*pz + m[3];
        float mv_y = m[4]*px + m[5]*py + m[6]*pz + m[7];
        float clip_x = mv_x, clip_y = mv_y;
        if (summary_cb.m_proj_set && summary_cb.m_proj_type == 1) // orthographic
        {
          clip_x = mv_x * summary_cb.m_proj_params[0] + summary_cb.m_proj_params[1];
          clip_y = mv_y * summary_cb.m_proj_params[2] + summary_cb.m_proj_params[3];
        }
        else if (summary_cb.m_proj_set && summary_cb.m_proj_type == 0) // perspective
        {
          float mv_z = m[8]*px + m[9]*py + m[10]*pz + m[11];
          clip_x = (mv_x * summary_cb.m_proj_params[0] + mv_z * summary_cb.m_proj_params[1]) / -mv_z;
          clip_y = (mv_y * summary_cb.m_proj_params[2] + mv_z * summary_cb.m_proj_params[3]) / -mv_z;
        }
        float sx = clip_x * summary_cb.m_vp_wd + summary_cb.m_vp_x_orig;
        float sy = clip_y * summary_cb.m_vp_ht + summary_cb.m_vp_y_orig;
        return {sx, sy};
      };

      // Transform vertices to screen-space and collect quad corners
      for (const auto& pg : summary_cb.m_primitives)
      {
        std::vector<ScreenVert> pg_verts;
        for (const auto& v : pg.vertices)
        {
          if (!v.has_pos) continue;
          auto [sx, sy] = transform_vert(v.px, v.py, v.pz, v.pos_idx);
          float r = v.has_color ? (v.cr / 255.0f) : 1.0f;
          float g = v.has_color ? (v.cg / 255.0f) : 1.0f;
          float b = v.has_color ? (v.cb / 255.0f) : 1.0f;
          float a = v.has_color ? (v.ca / 255.0f) : 1.0f;
          ScreenVert sv;
          sv.sx = sx; sv.sy = sy;
          for (int t = 0; t < 8; t++) {
            sv.uvs[t][0] = v.has_uv_set[t] ? v.uvs[t][0] : 0.0f;
            sv.uvs[t][1] = v.has_uv_set[t] ? v.uvs[t][1] : 0.0f;
          }
          sv.r = r; sv.g = g; sv.b = b; sv.a = a;
          pg_verts.push_back(sv);
        }

        // Triangulate based on primitive type
        if (pg.type == OpcodeDecoder::Primitive::GX_DRAW_QUADS)
        {
          for (size_t i = 0; i + 3 < pg_verts.size(); i += 4)
          {
            triangles.push_back(pg_verts[i]);
            triangles.push_back(pg_verts[i + 1]);
            triangles.push_back(pg_verts[i + 2]);
            triangles.push_back(pg_verts[i]);
            triangles.push_back(pg_verts[i + 2]);
            triangles.push_back(pg_verts[i + 3]);
          }
        }
        else if (pg.type == OpcodeDecoder::Primitive::GX_DRAW_TRIANGLES)
        {
          for (size_t i = 0; i + 2 < pg_verts.size(); i += 3)
          {
            triangles.push_back(pg_verts[i]);
            triangles.push_back(pg_verts[i + 1]);
            triangles.push_back(pg_verts[i + 2]);
          }
        }
        else if (pg.type == OpcodeDecoder::Primitive::GX_DRAW_TRIANGLE_STRIP)
        {
          for (size_t i = 0; i + 2 < pg_verts.size(); i++)
          {
            triangles.push_back(pg_verts[i]);
            if (i % 2 == 0)
            {
              triangles.push_back(pg_verts[i + 1]);
              triangles.push_back(pg_verts[i + 2]);
            }
            else
            {
              triangles.push_back(pg_verts[i + 2]);
              triangles.push_back(pg_verts[i + 1]);
            }
          }
        }
        else if (pg.type == OpcodeDecoder::Primitive::GX_DRAW_TRIANGLE_FAN)
        {
          for (size_t i = 1; i + 1 < pg_verts.size(); i++)
          {
            triangles.push_back(pg_verts[0]);
            triangles.push_back(pg_verts[i]);
            triangles.push_back(pg_verts[i + 1]);
          }
        }
      }

      // Decode TEV registers for this object
      auto decode_reg = [](u32 ra, u32 bg, int& r, int& g, int& b, int& a) {
        r = std::clamp(int(ra & 0x7FF), 0, 255);
        a = std::clamp(int((ra >> 12) & 0x7FF), 0, 255);
        b = std::clamp(int(bg & 0x7FF), 0, 255);
        g = std::clamp(int((bg >> 12) & 0x7FF), 0, 255);
      };

      // Write JSON object
      if (!first_obj) json << ",\n";
      first_obj = false;

      json << "        {\n";
      json << "          \"objectIndex\": " << object_idx << ",\n";

      // (screenX/Y/W/H and uvTL/BR removed — raw data is in quad[] and vertices[])

      // Screen-space triangles — final pixel positions + UVs + vertex colors.
      if (triangles.size() > 0)
      {
        json << "          \"triangles\": [\n";
        for (size_t qi = 0; qi < triangles.size(); qi++)
        {
          const auto& qv = triangles[qi];
          json << fmt::format("            {{\"sx\": {:.2f}, \"sy\": {:.2f}, \"uvs\": [", qv.sx, qv.sy);
          for (int t = 0; t < 8; t++) {
            if (t > 0) json << ", ";
            json << fmt::format("[{:.6f}, {:.6f}]", qv.uvs[t][0], qv.uvs[t][1]);
          }
          json << fmt::format("], \"r\": {:.6f}, \"g\": {:.6f}, \"b\": {:.6f}, \"a\": {:.6f}}}",
                              qv.r, qv.g, qv.b, qv.a);
          if (qi + 1 < triangles.size()) json << ",";
          json << "\n";
        }
        json << "          ],\n";
      }

      // (translateX/Y/Z, scaleX/Y removed — full matrix is in posMatrix via quad[])

      // Textures
      json << "          \"textures\": [";
      bool first_tex = true;
      for (int i = 0; i < 8; i++)
      {
        if (!summary_cb.m_tex_set[i]) continue;
        if (!first_tex) json << ", ";
        first_tex = false;

        // Find the exported filename for this texture
        auto it = tex_addr_to_filename.find(summary_cb.m_tex_addr[i]);
        std::string fname = (it != tex_addr_to_filename.end()) ? it->second :
            fmt::format("tex_0x{:08X}_{}x{}.png", summary_cb.m_tex_addr[i],
                        summary_cb.m_tex_width[i], summary_cb.m_tex_height[i]);
        // Include wrap modes if available (0=Clamp, 1=Repeat, 2=Mirror)
        int wrapS = summary_cb.m_tex_wrap_set[i] ? summary_cb.m_tex_wrap_s[i] : 0;
        int wrapT = summary_cb.m_tex_wrap_set[i] ? summary_cb.m_tex_wrap_t[i] : 0;
        json << fmt::format("{{\"unit\": {}, \"file\": \"{}\", \"width\": {}, \"height\": {}, "
                             "\"fmt\": {}, \"addr\": \"0x{:08X}\", \"wrapS\": {}, \"wrapT\": {}}}",
                             i, fname, summary_cb.m_tex_width[i], summary_cb.m_tex_height[i],
                             summary_cb.m_tex_fmt[i], summary_cb.m_tex_addr[i], wrapS, wrapT);
      }
      json << "],\n";

      // TEV color registers (c0-c3, the "color" bank)
      json << "          \"tevColorRegs\": {";
      {
        bool first_reg = true;
        for (int i = 0; i < 4; i++)
        {
          if (!summary_cb.m_tev_color_set[i]) continue;
          if (!first_reg) json << ", ";
          first_reg = false;
          int r, g, b, a;
          decode_reg(summary_cb.m_tev_color_ra[i], summary_cb.m_tev_color_bg[i], r, g, b, a);
          json << fmt::format("\"c{}\": [{}, {}, {}, {}]", i, r, g, b, a);
        }
      }
      json << "},\n";

      // TEV konst registers (k0-k3, the "konst" bank)
      json << "          \"tevKonstRegs\": {";
      {
        bool first_reg = true;
        for (int i = 0; i < 4; i++)
        {
          if (!summary_cb.m_tev_konst_set[i]) continue;
          if (!first_reg) json << ", ";
          first_reg = false;
          int r, g, b, a;
          decode_reg(summary_cb.m_tev_konst_ra[i], summary_cb.m_tev_konst_bg[i], r, g, b, a);
          json << fmt::format("\"k{}\": [{}, {}, {}, {}]", i, r, g, b, a);
        }
      }
      json << "},\n";

      // TEV stages
      json << fmt::format("          \"tevStages\": {},\n", summary_cb.m_num_tev_stages);

      // Channel 0 alpha source: 0=Register, 1=Vertex
      // When vertex alpha is the source and all vertex alpha=0, TEV stages that
      // multiply by raster alpha will produce zero alpha → fully transparent.
      if (summary_cb.m_chan0_alpha_src >= 0)
      {
        json << fmt::format("          \"chan0AlphaSrc\": {},\n", summary_cb.m_chan0_alpha_src);
      }

      // TEV alpha combiner inputs per stage: [a, b, c, d] indices
      // Alpha input names: 0=prev, 1=c0, 2=c1, 3=c2, 4=tex, 5=ras, 6=konst, 7=zero
      // The compositor uses this to detect patterns like "prev * ras" (vertex modulation).
      {
        json << "          \"tevAlphaOps\": [";
        bool first_stage = true;
        for (u32 s = 0; s < summary_cb.m_num_tev_stages && s < 16; s++)
        {
          if (!summary_cb.m_tev_env_set[s]) continue;
          TevStageCombiner::AlphaCombiner ac;
          ac.hex = summary_cb.m_tev_alpha_env[s];
          if (!first_stage) json << ", ";
          first_stage = false;
          json << fmt::format("[{}, {}, {}, {}]",
                              static_cast<u32>(ac.a.Value()),
                              static_cast<u32>(ac.b.Value()),
                              static_cast<u32>(ac.c.Value()),
                              static_cast<u32>(ac.d.Value()));
        }
        json << "],\n";
      }

      // TEV color combiner inputs per stage: [a, b, c, d] indices
      // Color input names: 0=prev, 1=prev_alpha, 2=c0, 3=c0_alpha,
      //   4=c1, 5=c1_alpha, 6=c2, 7=c2_alpha, 8=tex, 9=tex_alpha,
      //   10=ras, 11=ras_alpha, 12=ONE(8/8th), 13=HALF(4/8th), 14=konst, 15=ZERO
      {
        json << "          \"tevColorOps\": [";
        bool first_stage = true;
        for (u32 s = 0; s < summary_cb.m_num_tev_stages && s < 16; s++)
        {
          if (!summary_cb.m_tev_env_set[s]) continue;
          TevStageCombiner::ColorCombiner cc;
          cc.hex = summary_cb.m_tev_color_env[s];
          if (!first_stage) json << ", ";
          first_stage = false;
          json << fmt::format("[{}, {}, {}, {}]",
                              static_cast<u32>(cc.a.Value()),
                              static_cast<u32>(cc.b.Value()),
                              static_cast<u32>(cc.c.Value()),
                              static_cast<u32>(cc.d.Value()));
        }
        json << "],\n";
      }

      // Konst color and alpha selection per TEV stage
      // kcsel: which konst register feeds into the color "konst" input (14)
      // kasel: which konst register feeds into the alpha "konst" input (6)
      // Values are KonstSel enum indices (see BPMemory.h)
      {
        json << "          \"tevKonstSel\": [";
        bool first_stage = true;
        for (u32 s = 0; s < summary_cb.m_num_tev_stages && s < 16; s++)
        {
          if (!summary_cb.m_tev_env_set[s]) continue;
          int ksel_idx = s >> 1;
          u32 kcsel_val = 0, kasel_val = 0;
          if (summary_cb.m_ksel_set[ksel_idx])
          {
            TevKSel ksel; ksel.hex = summary_cb.m_ksel[ksel_idx];
            kcsel_val = static_cast<u32>((s & 1) ?
                ksel.kcsel_odd.Value() : ksel.kcsel_even.Value());
            kasel_val = static_cast<u32>((s & 1) ?
                ksel.kasel_odd.Value() : ksel.kasel_even.Value());
          }
          if (!first_stage) json << ", ";
          first_stage = false;
          json << fmt::format("[{}, {}]", kcsel_val, kasel_val);
        }
        json << "],\n";
      }

      // TREF: per-stage texture map index, texture coord index, enable flag,
      // and raster color channel binding
      // rasChannel: 0=Color0A0, 1=Color1A1, 5=AlphaBump, 7=Zero(disabled)
      if (summary_cb.m_tref_set)
      {
        json << "          \"tevTref\": [";
        bool first_stage = true;
        for (u32 s = 0; s < summary_cb.m_num_tev_stages && s < 16; s++)
        {
          if (!summary_cb.m_tev_env_set[s]) continue;
          int tref_idx = s / 2;
          int tref_sub = s % 2;
          u32 texmap = 0, texcoord = 0, ras_chan = 7;
          bool enable = false;
          if (tref_idx < 8)
          {
            TwoTevStageOrders tref; tref.hex = summary_cb.m_tref[tref_idx];
            texmap = tref.getTexMap(tref_sub);
            texcoord = tref.getTexCoord(tref_sub);
            enable = tref.getEnable(tref_sub);
            ras_chan = static_cast<u32>(tref.getColorChan(tref_sub));
          }
          if (!first_stage) json << ", ";
          first_stage = false;
          json << fmt::format("{{\"texMap\": {}, \"texCoord\": {}, \"texEnable\": {}, \"rasChannel\": {}}}",
                              texmap, texcoord, enable ? "true" : "false", ras_chan);
        }
        json << "],\n";
      }

      // Channel 0 color source: 0=Register, 1=Vertex
      if (summary_cb.m_chan0_color_src >= 0)
      {
        json << fmt::format("          \"chan0ColorSrc\": {},\n", summary_cb.m_chan0_color_src);
      }

      // Scissor rectangle (screen-space clip region)
      // GX scissor register values are in the same coordinate space as the
      // viewport-transformed quad positions (both include the GX hardware
      // EFB bias). Verified: scissor raw values match quad sx/sy within 2px
      // for all channel texture objects.
      // BR values use +1 because the scissor range is inclusive.
      if (summary_cb.m_scissor_set)
      {
        ScissorPos stl; stl.hex = summary_cb.m_scissor_tl;
        ScissorPos sbr; sbr.hex = summary_cb.m_scissor_br;
        float sx0 = static_cast<float>(stl.x.Value());
        float sy0 = static_cast<float>(stl.y.Value());
        float sx1 = static_cast<float>(sbr.x.Value()) + 1.0f;
        float sy1 = static_cast<float>(sbr.y.Value()) + 1.0f;
        json << fmt::format("          \"scissor\": {{\"x0\": {:.1f}, \"y0\": {:.1f}, \"x1\": {:.1f}, \"y1\": {:.1f}}},\n",
                            sx0, sy0, sx1, sy1);
      }

      // Blend mode
      if (summary_cb.m_blend_set)
      {
        BlendMode bm;
        bm.hex = summary_cb.m_blend_val;
        json << fmt::format("          \"blendSrc\": {},\n", static_cast<u32>(bm.src_factor.Value()));
        json << fmt::format("          \"blendDst\": {},\n", static_cast<u32>(bm.dst_factor.Value()));
        json << fmt::format("          \"blendEnable\": {},\n", bm.blend_enable ? "true" : "false");
      }

      // Vertex data (positions + colors for each vertex) handled in triangles array.

      // Draw order
      json << "          \"drawOrder\": " << object_idx << "\n";
      json << "        }";

      // (HTML generation moved to post-JSON canvas renderer)

      object_idx++;
      total_objects++;
    }

    json << "\n      ]\n";
    json << "    }";
  }

  json << "\n  ]\n";
  json << "}\n";

  // Write scene.json
  const std::filesystem::path json_path = export_dir / "scene.json";
  std::ofstream json_file(json_path.string());
  if (json_file.is_open())
  {
    json_file << json.str();
    json_file.close();
  }

  // Build canvas-based HTML with embedded JSON and JS TEV simulator
  const std::string json_data = json.str();
  html << "<!DOCTYPE html>\n<html>\n<head>\n<style>\n";
  html << "  body { background: #222; margin: 0; padding: 20px; font-family: monospace; }\n";
  html << "  canvas { display: block; margin: 0 auto; image-rendering: pixelated; ";
  html << "box-shadow: 0 0 20px rgba(0,0,0,0.5); }\n";
  html << "  #status { color: #aaa; text-align: center; margin-top: 10px; font-size: 12px; }\n";
  html << "</style>\n</head>\n<body>\n";
  html << "<canvas id=\"scene\" width=\"608\" height=\"456\"></canvas>\n";
  html << "<div id=\"status\">Loading textures...</div>\n";
  html << "<script>\n";
  html << "const SCENE = " << json_data << ";\n";
  html << R"JS(
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const W = 608, H = 456;

// GX EFB bias: hardware adds 342 to scissor/viewport coords
const EFB_BIAS = 342;

// Load all textures, then render
async function loadTextures(objects) {
  const texMap = {};
  const promises = [];
  for (const obj of objects) {
    for (const tex of (obj.textures || [])) {
      if (texMap[tex.file]) continue;
      texMap[tex.file] = null;
      const p = new Promise(resolve => {
        const img = new Image();
        img.onload = () => { texMap[tex.file] = img; resolve(); };
        img.onerror = () => resolve();
        img.src = 'textures/' + tex.file;
      });
      promises.push(p);
    }
  }
  await Promise.all(promises);
  return texMap;
}

// Sample texture at UV coordinates, returns [r,g,b,a] 0-255
function sampleTex(texImg, u, v, wrapS, wrapT) {
  if (!texImg) return [255, 255, 255, 255];

  // Apply wrap mode: 0=Clamp, 1=Repeat, 2=Mirror
  function applyWrap(coord, mode) {
    if (mode === 1) { coord = coord % 1; if (coord < 0) coord += 1; }
    else if (mode === 2) {
      coord = Math.abs(coord);
      const i = Math.floor(coord);
      coord = (i & 1) ? 1 - (coord - i) : (coord - i);
    }
    else { coord = Math.max(0, Math.min(1, coord)); }
    return coord;
  }

  u = applyWrap(u, wrapS);
  v = applyWrap(v, wrapT);

  // Draw to offscreen canvas to get pixel data
  if (!texImg._canvas) {
    const c = document.createElement('canvas');
    c.width = texImg.naturalWidth;
    c.height = texImg.naturalHeight;
    const tc = c.getContext('2d');
    tc.drawImage(texImg, 0, 0);
    texImg._data = tc.getImageData(0, 0, c.width, c.height);
    texImg._canvas = c;
  }

  const data = texImg._data;
  const px = Math.min(Math.floor(u * data.width), data.width - 1);
  const py = Math.min(Math.floor(v * data.height), data.height - 1);
  const idx = (py * data.width + px) * 4;
  return [data.data[idx], data.data[idx+1], data.data[idx+2], data.data[idx+3]];
}

// TEV combiner: result = d + ((1-c)*a + c*b) + bias, then scale
// For alpha: same formula but single channel
function tevCombine(a, b, c, d, bias, op, scale, clamp) {
  // result = d + (a*(1-c) + b*c) with bias and scale
  let result = d + (a * (1 - c) + b * c);
  if (bias === 1) result += 0.5;      // +0.5
  else if (bias === 2) result -= 0.5; // -0.5
  // bias === 3 is compare mode, handled separately

  if (op === 1) result = d - (a * (1 - c) + b * c); // subtract

  if (scale === 1) result *= 2;
  else if (scale === 2) result *= 4;
  else if (scale === 3) result *= 0.5;

  if (clamp) result = Math.max(0, Math.min(1, result));
  return result;
}

// Resolve a TEV color input index to [r,g,b] normalized 0-1
// Color inputs: 0=prev, 1=prev.a, 2=c0, 3=c0.a, 4=c1, 5=c1.a,
//   6=c2, 7=c2.a, 8=tex, 9=tex.a, 10=ras, 11=ras.a,
//   12=ONE, 13=HALF, 14=konst, 15=ZERO
function getColorInput(idx, regs, tex, ras, konst) {
  const r = regs; // {prev, c0, c1, c2} each [r,g,b,a]
  switch(idx) {
    case 0: return [r.prev[0], r.prev[1], r.prev[2]];
    case 1: return [r.prev[3], r.prev[3], r.prev[3]];
    case 2: return [r.c0[0], r.c0[1], r.c0[2]];
    case 3: return [r.c0[3], r.c0[3], r.c0[3]];
    case 4: return [r.c1[0], r.c1[1], r.c1[2]];
    case 5: return [r.c1[3], r.c1[3], r.c1[3]];
    case 6: return [r.c2[0], r.c2[1], r.c2[2]];
    case 7: return [r.c2[3], r.c2[3], r.c2[3]];
    case 8: return [tex[0], tex[1], tex[2]];
    case 9: return [tex[3], tex[3], tex[3]];
    case 10: return [ras[0], ras[1], ras[2]];
    case 11: return [ras[3], ras[3], ras[3]];
    case 12: return [1, 1, 1]; // ONE (8/8)
    case 13: return [0.5, 0.5, 0.5]; // HALF (4/8)
    case 14: return [konst[0], konst[1], konst[2]];
    case 15: return [0, 0, 0]; // ZERO
    default: return [0, 0, 0];
  }
}

// Resolve a TEV alpha input index to scalar 0-1
// Alpha inputs: 0=prev, 1=c0, 2=c1, 3=c2, 4=tex, 5=ras, 6=konst, 7=zero
function getAlphaInput(idx, regs, tex, ras, konst) {
  switch(idx) {
    case 0: return regs.prev[3];
    case 1: return regs.c0[3];
    case 2: return regs.c1[3];
    case 3: return regs.c2[3];
    case 4: return tex[3];
    case 5: return ras[3];
    case 6: return konst[3];
    case 7: return 0;
    default: return 0;
  }
}

// Resolve konst color selection (kcsel) to [r,g,b,a] 0-1
// KonstSel values: 0-7 = constant fractions (1, 7/8, 3/4, ...),
// 12=k0.rgb, 16=k0.rrr, etc.
function getKonstColor(kcsel, kasel, konstRegs) {
  const fracs = [1, 7/8, 3/4, 5/8, 1/2, 3/8, 1/4, 1/8];
  let kr = 1, kg = 1, kb = 1, ka = 1;

  if (kcsel <= 7) { kr = kg = kb = fracs[kcsel]; }
  else if (kcsel >= 12 && kcsel <= 15) {
    const k = konstRegs['k' + (kcsel - 12)] || [255,255,255,255];
    kr = k[0]/255; kg = k[1]/255; kb = k[2]/255;
  }
  else if (kcsel >= 16 && kcsel <= 19) {
    const k = konstRegs['k' + (kcsel - 16)] || [255,255,255,255];
    kr = kg = kb = k[0]/255; // .rrr
  }
  else if (kcsel >= 20 && kcsel <= 23) {
    const k = konstRegs['k' + (kcsel - 20)] || [255,255,255,255];
    kr = kg = kb = k[1]/255; // .ggg
  }
  else if (kcsel >= 24 && kcsel <= 27) {
    const k = konstRegs['k' + (kcsel - 24)] || [255,255,255,255];
    kr = kg = kb = k[2]/255; // .bbb
  }
  else if (kcsel >= 28 && kcsel <= 31) {
    const k = konstRegs['k' + (kcsel - 28)] || [255,255,255,255];
    kr = kg = kb = k[3]/255; // .aaa
  }

  if (kasel <= 7) { ka = fracs[kasel]; }
  else if (kasel >= 16 && kasel <= 19) {
    const k = konstRegs['k' + (kasel - 16)] || [255,255,255,255];
    ka = k[0]/255;
  }
  else if (kasel >= 20 && kasel <= 23) {
    const k = konstRegs['k' + (kasel - 20)] || [255,255,255,255];
    ka = k[1]/255;
  }
  else if (kasel >= 24 && kasel <= 27) {
    const k = konstRegs['k' + (kasel - 24)] || [255,255,255,255];
    ka = k[2]/255;
  }
  else if (kasel >= 28 && kasel <= 31) {
    const k = konstRegs['k' + (kasel - 28)] || [255,255,255,255];
    ka = k[3]/255;
  }

  return [kr, kg, kb, ka];
}

// GX blend factor to multiplier
function blendFactor(factor, src, dst) {
  switch(factor) {
    case 0: return [0,0,0,0]; // Zero
    case 1: return [1,1,1,1]; // One
    case 2: return [src[0], src[1], src[2], src[3]]; // SrcClr or DstClr
    case 3: return [1-src[0], 1-src[1], 1-src[2], 1-src[3]]; // InvSrcClr
    case 4: return [src[3], src[3], src[3], src[3]]; // SrcAlpha
    case 5: return [1-src[3], 1-src[3], 1-src[3], 1-src[3]]; // InvSrcAlpha
    case 6: return [dst[3], dst[3], dst[3], dst[3]]; // DstAlpha
    case 7: return [1-dst[3], 1-dst[3], 1-dst[3], 1-dst[3]]; // InvDstAlpha
    default: return [1,1,1,1];
  }
}

// Compute barycentric coordinates for point (px,py) in triangle (v0, v1, v2)
// Returns [w0, w1, w2] or null if outside.
function barycentric(px, py, v0, v1, v2) {
  const d00 = v1.sx - v0.sx;
  const d01 = v2.sx - v0.sx;
  const d10 = v1.sy - v0.sy;
  const d11 = v2.sy - v0.sy;
  const det = d00 * d11 - d01 * d10;
  if (Math.abs(det) < 0.000001) return null; // Degenerate 

  const dx = px - v0.sx;
  const dy = py - v0.sy;
  const beta = (dx * d11 - dy * d01) / det;
  const gamma = (d00 * dy - d10 * dx) / det;
  const alpha = 1.0 - beta - gamma;

  // A small epsilon allows picking up edge pixels
  const eps = -0.001; 
  if (alpha >= eps && beta >= eps && gamma >= eps) {
    return [Math.max(0, alpha), Math.max(0, beta), Math.max(0, gamma)];
  }
  return null;
}

async function render() {
  const frames = SCENE.frames || [];
  if (frames.length === 0) return;

  const allObjects = [];
  for (const frame of frames) {
    for (const obj of (frame.objects || [])) {
      allObjects.push(obj);
    }
  }

  const texMap = await loadTextures(allObjects);
  document.getElementById('status').textContent =
    'Rendering ' + allObjects.length + ' objects...';

  // Create framebuffer
  const fb = ctx.createImageData(W, H);
  // Initialize to black, alpha=1
  for (let i = 0; i < fb.data.length; i += 4) {
    fb.data[i] = 0; fb.data[i+1] = 0; fb.data[i+2] = 0; fb.data[i+3] = 255;
  }

  // Process each object in draw order
  for (let objIdx = 0; objIdx < allObjects.length; objIdx++) {
    const obj = allObjects[objIdx];
    
    if (objIdx % 10 === 0) {
      document.getElementById('status').textContent = 
        'Rendering ' + objIdx + ' / ' + allObjects.length + ' objects...';
      ctx.putImageData(fb, 0, 0); // Show progressive render
      await new Promise(r => setTimeout(r, 1)); // Yield to unblock browser
    }

    const triangles = obj.triangles;
    if (!triangles || triangles.length === 0) continue;

    // Scissor clip (scissor values also include EFB bias)
    let scX0 = 0, scY0 = 0, scX1 = W, scY1 = H;
    if (obj.scissor) {
      scX0 = obj.scissor.x0 - EFB_BIAS;
      scY0 = obj.scissor.y0 - EFB_BIAS;
      scX1 = obj.scissor.x1 - EFB_BIAS;
      scY1 = obj.scissor.y1 - EFB_BIAS;
    }

    // Get texture info
    const texInfo = (obj.textures && obj.textures.length > 0) ? obj.textures[0] : null;
    const texImg = texInfo ? texMap[texInfo.file] : null;
    const wrapS = texInfo ? texInfo.wrapS : 0;
    const wrapT = texInfo ? texInfo.wrapT : 0;

    // TEV state
    const colorRegs = obj.tevColorRegs || {};
    const konstRegs = obj.tevKonstRegs || {};
    const tevColorOps = obj.tevColorOps || [];
    const tevAlphaOps = obj.tevAlphaOps || [];
    const tevKonstSel = obj.tevKonstSel || [];

    // Blend mode
    const blendEnable = obj.blendEnable !== undefined ? obj.blendEnable : true;
    const blendSrc = obj.blendSrc !== undefined ? obj.blendSrc : 4; // SrcAlpha
    const blendDst = obj.blendDst !== undefined ? obj.blendDst : 5; // InvSrcAlpha

    // Adjust triangles to 0-based screen coords
    const adjTriangles = triangles.map(v => ({
      sx: v.sx - EFB_BIAS, sy: v.sy - EFB_BIAS, 
      uvs: v.uvs, 
      r: v.r, g: v.g, b: v.b, a: v.a
    }));

    // Iterate over each triangle
    for (let i = 0; i < adjTriangles.length; i += 3) {
      const v0 = adjTriangles[i], v1 = adjTriangles[i+1], v2 = adjTriangles[i+2];

      // Compute triangle AABB
      const tMinX = Math.min(v0.sx, v1.sx, v2.sx);
      const tMinY = Math.min(v0.sy, v1.sy, v2.sy);
      const tMaxX = Math.max(v0.sx, v1.sx, v2.sx);
      const tMaxY = Math.max(v0.sy, v1.sy, v2.sy);

      // Effective draw region
      const rx0 = Math.max(0, Math.floor(Math.max(tMinX, scX0)));
      const ry0 = Math.max(0, Math.floor(Math.max(tMinY, scY0)));
      const rx1 = Math.min(W, Math.ceil(Math.min(tMaxX, scX1)));
      const ry1 = Math.min(H, Math.ceil(Math.min(tMaxY, scY1)));
      if (rx0 >= rx1 || ry0 >= ry1) continue;

      // Rasterize pixels in the bounding box
      for (let py = ry0; py < ry1; py++) {
        for (let px = rx0; px < rx1; px++) {
          const weights = barycentric(px + 0.5, py + 0.5, v0, v1, v2);
          if (!weights) continue;
          
          const [w0, w1, w2] = weights;
          const uvs = [];
          for (let t = 0; t < 8; t++) {
            const u = w0 * v0.uvs[t][0] + w1 * v1.uvs[t][0] + w2 * v2.uvs[t][0];
            const vParam = w0 * v0.uvs[t][1] + w1 * v1.uvs[t][1] + w2 * v2.uvs[t][1];
            uvs.push([u, vParam]);
          }
          
          const rasColor = [
            w0 * v0.r + w1 * v1.r + w2 * v2.r,
            w0 * v0.g + w1 * v1.g + w2 * v2.g,
            w0 * v0.b + w1 * v1.b + w2 * v2.b,
            w0 * v0.a + w1 * v1.a + w2 * v2.a
          ];

          // Initialize TEV registers
          const tevRegs = {
            prev: [0, 0, 0, 0],
            c0: (colorRegs.c0 || [0,0,0,0]).map(c => c/255),
            c1: (colorRegs.c1 || [0,0,0,0]).map(c => c/255),
            c2: (colorRegs.c2 || [0,0,0,0]).map(c => c/255),
          };

        // Run TEV stages
        const tevTref = obj.tevTref || [];
        const numStages = Math.min(tevColorOps.length, tevAlphaOps.length);
        for (let s = 0; s < numStages; s++) {
          const cOp = tevColorOps[s];
          const aOp = tevAlphaOps[s];
          const ksel = tevKonstSel[s] || [0, 0];
          const konst = getKonstColor(ksel[0], ksel[1], konstRegs);

          let texSample = [1, 1, 1, 1];
          const tref = tevTref[s];
          if (tref && tref.texEnable) {
            const texMapIdx = tref.texMap;
            const texCoordIdx = tref.texCoord < 8 ? tref.texCoord : 0;
            const tInfo = (obj.textures || []).find(t => t.unit === texMapIdx);
            if (tInfo) {
              const tImg = texMap[tInfo.file];
              const uvCoord = uvs[texCoordIdx];
              texSample = sampleTex(tImg, uvCoord[0], uvCoord[1], tInfo.wrapS, tInfo.wrapT).map(c => c/255);
            }
          }

          // Color combiner
          const ca = getColorInput(cOp[0], tevRegs, texSample, rasColor, konst);
          const cb_ = getColorInput(cOp[1], tevRegs, texSample, rasColor, konst);
          const cc = getColorInput(cOp[2], tevRegs, texSample, rasColor, konst);
          const cd = getColorInput(cOp[3], tevRegs, texSample, rasColor, konst);

          const outR = tevCombine(ca[0], cb_[0], cc[0], cd[0], 0, 0, 0, true);
          const outG = tevCombine(ca[1], cb_[1], cc[1], cd[1], 0, 0, 0, true);
          const outB = tevCombine(ca[2], cb_[2], cc[2], cd[2], 0, 0, 0, true);

          // Alpha combiner
          const aa = getAlphaInput(aOp[0], tevRegs, texSample, rasColor, konst);
          const ab = getAlphaInput(aOp[1], tevRegs, texSample, rasColor, konst);
          const ac = getAlphaInput(aOp[2], tevRegs, texSample, rasColor, konst);
          const ad = getAlphaInput(aOp[3], tevRegs, texSample, rasColor, konst);

          const outA = tevCombine(aa, ab, ac, ad, 0, 0, 0, true);

          tevRegs.prev = [outR, outG, outB, outA];
        }

        // Final color from TEV
        const srcColor = tevRegs.prev;

        // Get destination pixel from framebuffer
        const fbIdx = (py * W + px) * 4;
        const dstColor = [
          fb.data[fbIdx] / 255,
          fb.data[fbIdx+1] / 255,
          fb.data[fbIdx+2] / 255,
          fb.data[fbIdx+3] / 255
        ];

        // Apply blend mode
        let finalR, finalG, finalB, finalA;
        if (blendEnable) {
          const sf = blendFactor(blendSrc, srcColor, dstColor);
          const df = blendFactor(blendDst, srcColor, dstColor);
          finalR = srcColor[0] * sf[0] + dstColor[0] * df[0];
          finalG = srcColor[1] * sf[1] + dstColor[1] * df[1];
          finalB = srcColor[2] * sf[2] + dstColor[2] * df[2];
          finalA = srcColor[3] * sf[3] + dstColor[3] * df[3];
        } else {
          finalR = srcColor[0];
          finalG = srcColor[1];
          finalB = srcColor[2];
          finalA = srcColor[3];
        }

        fb.data[fbIdx]   = Math.max(0, Math.min(255, Math.round(finalR * 255)));
        fb.data[fbIdx+1] = Math.max(0, Math.min(255, Math.round(finalG * 255)));
        fb.data[fbIdx+2] = Math.max(0, Math.min(255, Math.round(finalB * 255)));
        fb.data[fbIdx+3] = 255; // Always opaque on screen
      }
    }
  }
  }

  ctx.putImageData(fb, 0, 0);
  document.getElementById('status').textContent =
    'Done: ' + allObjects.length + ' objects rendered';
}

render();
)JS";
  html << "</script>\n</body>\n</html>\n";

  const std::filesystem::path html_path = export_dir / "scene.html";
  std::ofstream html_file(html_path.string());
  if (html_file.is_open())
  {
    html_file << html.str();
    html_file.close();
  }

  if (!headless)
  {
    QMessageBox::information(this, tr("Export Scene"),
        tr("Exported scene to:\n%1\nAnd HTML to:\n%2\n\n%3 objects processed\n%4 textures exported")
            .arg(QString::fromStdString(json_path.string()))
            .arg(QString::fromStdString(html_path.string()))
            .arg(total_objects)
            .arg(tex_export_count));
  }
}
